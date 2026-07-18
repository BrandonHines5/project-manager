import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  extractVendorDocument,
  isExtractableType,
  type VendorDocExtraction,
} from "./extract"
import type { Database, Json } from "@/lib/db/types"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Shared vendor-document ingestion pipeline. All three entry points funnel
 * here:
 *   - the Resend inbound-email webhook (source 'email')
 *   - the public tokenized sub upload page (source 'upload', company known)
 *   - staff manual upload from the Vendor Documents page (source 'manual')
 *
 * Runs on the ADMIN client on purpose: the webhook and the public upload
 * route have no user session, and staff callers are gated by requireStaff()
 * before they get here. Steps: store the file → record the document →
 * classify + extract with Claude → match a company → materialize policy rows
 * (certificates only). Every failure mode lands as a document status
 * ('failed' / 'needs_review') instead of a thrown error, so webhooks don't
 * retry-loop and the staff dashboard shows what needs a human.
 */

type Admin = SupabaseClient<Database>

export const INSURANCE_BUCKET = "project-files"

export type InsuranceDocKind = "coi" | "w9" | "sma" | "other"

export type IngestInput = {
  fileName: string
  fileType: string | null
  source: "email" | "upload" | "manual"
  // Provide bytes for webhook/route callers, or storagePath when the browser
  // already uploaded the file to Storage (staff flow, mirrors daily logs).
  bytes?: Buffer
  storagePath?: string
  fileSize?: number
  emailFrom?: string
  emailSubject?: string
  // Known company (tokenized sub upload, or staff picked one).
  companyId?: string
  // Explicit staff-chosen document kind. When ABSENT, the Claude extraction
  // classifies the document (COI / W9 / SMA / other) — that's the default
  // for every ingest path now. COIs materialize policy rows; W9s and
  // Subcontractor Master Agreements are stored and auto-matched to a company
  // by the same signals as certificates; anything unrecognized ('other')
  // lands in the review queue.
  docKind?: Exclude<InsuranceDocKind, "other">
}

export type IngestResult =
  | {
      ok: true
      documentId: string
      // 'pending' = the document row exists (visible in the review queue as
      // "Processing…") but its terminal status write failed — nothing beyond
      // that is claimed.
      status: "processed" | "needs_review" | "failed" | "pending"
    }
  | { ok: false; error: string }

export async function ingestInsuranceDocument(
  input: IngestInput
): Promise<IngestResult> {
  const admin = createSupabaseAdminClient()
  if (!admin) {
    return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not configured" }
  }
  if (!isExtractableType(input.fileType)) {
    return {
      ok: false,
      error: `Unsupported file type ${input.fileType ?? "(unknown)"} — send a PDF or an image`,
    }
  }

  // 1. Make sure the file is in Storage and we have its bytes.
  let storagePath = input.storagePath
  let bytes = input.bytes
  if (bytes && !storagePath) {
    const ext = extensionFor(input.fileType!, input.fileName)
    storagePath = `companies/insurance/${crypto.randomUUID()}${ext}`
    const { error: upErr } = await admin.storage
      .from(INSURANCE_BUCKET)
      .upload(storagePath, bytes, {
        contentType: input.fileType ?? undefined,
        upsert: false,
      })
    if (upErr) return { ok: false, error: `Storage upload failed: ${upErr.message}` }
  } else if (storagePath && !bytes) {
    const { data, error: dlErr } = await admin.storage
      .from(INSURANCE_BUCKET)
      .download(storagePath)
    if (dlErr || !data) {
      return {
        ok: false,
        error: `Could not read uploaded file: ${dlErr?.message ?? "empty"}`,
      }
    }
    bytes = Buffer.from(await data.arrayBuffer())
  }
  if (!bytes || !storagePath) {
    return { ok: false, error: "Provide either bytes or storagePath" }
  }

  // Explicit staff choice, or null = "let the extraction classify it".
  const explicitKind = input.docKind ?? null

  // 2. Record the document (status 'pending' until extraction lands). The
  // kind is provisional in auto-detect mode — every terminal update below
  // stamps the final classification alongside the status.
  const { data: doc, error: docErr } = await admin
    .from("insurance_documents")
    .insert({
      company_id: input.companyId ?? null,
      storage_bucket: INSURANCE_BUCKET,
      storage_path: storagePath,
      file_name: input.fileName,
      file_type: input.fileType,
      file_size: input.fileSize ?? bytes.length,
      source: input.source,
      doc_kind: explicitKind ?? "coi",
      email_from: input.emailFrom ?? null,
      email_subject: input.emailSubject ?? null,
    })
    .select("id")
    .single()
  if (docErr || !doc) {
    return { ok: false, error: `Could not record document: ${docErr?.message}` }
  }

  // Explicit W9/SMA WITH a company: staff already supplied both facts the
  // extraction would provide, so file it immediately — no model call.
  if (explicitKind && explicitKind !== "coi" && input.companyId) {
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({ status: "processed" })
      .eq("id", doc.id)
    if (updErr) {
      // Roll the row back so `ok:false` always means "nothing recorded" —
      // callers clean up the stored file on failure, which must never
      // orphan a document row that still points at it.
      await admin.from("insurance_documents").delete().eq("id", doc.id)
      return { ok: false, error: `Could not record document: ${updErr.message}` }
    }
    return { ok: true, documentId: doc.id, status: "processed" }
  }

  // 3. Classify + extract with Claude. Failures are recorded on the row, not
  // thrown — the file is safely stored, staff can see it and retry/assign
  // manually. For an explicit W9/SMA the extraction is only advisory (it
  // feeds auto-match), so its failure degrades to the review queue instead
  // of 'failed'.
  let extraction: VendorDocExtraction
  try {
    extraction = await extractVendorDocument(bytes, input.fileType!)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = explicitKind && explicitKind !== "coi" ? "needs_review" : "failed"
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({ status, extraction_error: msg })
      .eq("id", doc.id)
    if (updErr) {
      console.warn("[insurance] status write failed:", doc.id, updErr.message)
      return { ok: true, documentId: doc.id, status: "pending" }
    }
    return { ok: true, documentId: doc.id, status }
  }

  // The staff's explicit kind always wins over the classifier.
  const kind: InsuranceDocKind = explicitKind ?? extraction.doc_kind

  // 4. Resolve the company: explicit > email match > history/name match —
  // the same signals for every document kind.
  let companyId = input.companyId ?? null
  if (!companyId) {
    companyId = await matchCompany(admin, {
      emailFrom: input.emailFrom,
      companyName: extraction.company_name,
    })
  }

  // 5. Persist the outcome.
  // Unrecognized documents always need a human: even with a company known,
  // 'other' most likely means a misclassification or junk — the review card
  // lets staff correct the kind and assign in one step.
  if (kind === "other" || !companyId) {
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({
        status: "needs_review",
        doc_kind: kind,
        extracted_company_name: extraction.company_name,
        extraction: extraction as unknown as Json,
      })
      .eq("id", doc.id)
    if (updErr) {
      console.warn("[insurance] status write failed:", doc.id, updErr.message)
      return { ok: true, documentId: doc.id, status: "pending" }
    }
    return { ok: true, documentId: doc.id, status: "needs_review" }
  }

  // W9s and SMAs: no policy rows to materialize — file to the matched
  // company. The stored extracted_company_name teaches the history matcher
  // just like certificates do.
  if (kind !== "coi") {
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({
        status: "processed",
        doc_kind: kind,
        company_id: companyId,
        extracted_company_name: extraction.company_name,
        extraction: extraction as unknown as Json,
      })
      .eq("id", doc.id)
    if (updErr) {
      console.warn("[insurance] status write failed:", doc.id, updErr.message)
      return { ok: true, documentId: doc.id, status: "pending" }
    }
    return { ok: true, documentId: doc.id, status: "processed" }
  }

  try {
    await materializePolicies(admin, doc.id, companyId, extraction)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({
        status: "failed",
        doc_kind: kind,
        company_id: companyId,
        extracted_company_name: extraction.company_name,
        extraction: extraction as unknown as Json,
        extraction_error: msg,
      })
      .eq("id", doc.id)
    if (updErr) {
      console.warn("[insurance] status write failed:", doc.id, updErr.message)
      return { ok: true, documentId: doc.id, status: "pending" }
    }
    return { ok: true, documentId: doc.id, status: "failed" }
  }
  const { error: finalErr } = await admin
    .from("insurance_documents")
    .update({
      status: "processed",
      doc_kind: kind,
      company_id: companyId,
      extracted_company_name: extraction.company_name,
      extraction: extraction as unknown as Json,
    })
    .eq("id", doc.id)
  if (finalErr) {
    // Policies are booked but the row still says pending — visible in the
    // review queue, and the dedup index makes a re-run safe. Don't backfill
    // agent contact off a document that isn't actually marked processed.
    console.warn("[insurance] status write failed:", doc.id, finalErr.message)
    return { ok: true, documentId: doc.id, status: "pending" }
  }
  await fillAgentContactFromExtraction(admin, companyId, extraction)
  return { ok: true, documentId: doc.id, status: "processed" }
}

/**
 * Backfills the company's insurance-agent contact (agency name / email /
 * phone) from the certificate's Producer block — but only fields that are
 * currently BLANK. Staff-entered values always win; a new cert never
 * overwrites them. Each field is its own guarded UPDATE (`.is(col, null)`)
 * so the blank check and the write are one atomic statement — no
 * read-then-write window for a concurrent staff edit to lose in. (The edit
 * dialog stores cleared fields as null, so null IS the blank state.)
 * Best-effort: a failure here never fails the ingest.
 */
export async function fillAgentContactFromExtraction(
  client: Admin,
  companyId: string,
  extraction: VendorDocExtraction
): Promise<void> {
  const fields = [
    ["insurance_agent_name", extraction.producer_name?.trim()],
    ["insurance_agent_email", extraction.producer_email?.trim()],
    ["insurance_agent_phone", extraction.producer_phone?.trim()],
  ] as const
  for (const [column, value] of fields) {
    if (!value) continue
    // Spelled out per column so the patch keeps the typed Update shape (a
    // computed key widens to a string index signature the client rejects).
    const patch =
      column === "insurance_agent_name"
        ? { insurance_agent_name: value }
        : column === "insurance_agent_email"
          ? { insurance_agent_email: value }
          : { insurance_agent_phone: value }
    try {
      const { error } = await client
        .from("companies")
        .update(patch)
        .eq("id", companyId)
        .is(column, null)
      if (error) {
        console.warn("[insurance] agent-contact backfill failed:", error.message)
      }
    } catch (e) {
      console.warn("[insurance] agent-contact backfill failed:", e)
    }
  }
}

/**
 * Inserts policy rows from an extraction, skipping entries with no usable
 * expiration date (nothing to track) and entries that already exist — the
 * same cert emailed twice must not double-book policies. Used by ingest and
 * by the "assign to company" review action.
 */
export async function materializePolicies(
  admin: Admin,
  documentId: string,
  companyId: string,
  extraction: VendorDocExtraction
): Promise<number> {
  let inserted = 0
  for (const p of extraction.policies) {
    if (!p.expiration_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.expiration_date)) {
      continue
    }
    const { error } = await admin.from("insurance_policies").insert({
      company_id: companyId,
      document_id: documentId,
      type: p.type,
      carrier: p.carrier,
      policy_number: p.policy_number,
      effective_date:
        p.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(p.effective_date)
          ? p.effective_date
          : null,
      expiration_date: p.expiration_date,
      limits: (p.limits ?? []) as unknown as Json,
    })
    // 23505 = the uq_inspol_dedup unique index — same policy already on
    // file, which is exactly the "same cert sent twice" case. Skip quietly.
    // Anything else must bubble: silently dropping rows and then marking
    // the document processed would fake a complete extraction.
    if (error) {
      if (error.code === "23505") continue
      throw new Error(`Policy insert failed: ${error.message}`)
    }
    inserted++
  }
  return inserted
}

/**
 * Best-effort company match for email ingestion. Signals, strongest first:
 *   1. Sender email exactly matching a company's email on file.
 *   2. History — a previous certificate whose extracted insured name
 *      normalizes to the same string was already filed (manually or
 *      automatically) to a company. Staff assigning a cert in the review
 *      queue teaches the matcher that spelling permanently.
 *   3. The extracted insured name equal (exact, then suffix/punctuation-
 *      insensitive) to a company's official `name` OR its `aka`.
 * Only returns a company when the match is unambiguous — anything fuzzy
 * goes to the review queue instead.
 */
async function matchCompany(
  admin: Admin,
  hints: { emailFrom?: string; companyName?: string | null }
): Promise<string | null> {
  const address = parseEmailAddress(hints.emailFrom)
  if (address) {
    const { data } = await admin
      .from("companies")
      .select("id")
      .ilike("email", address)
    if (data && data.length === 1) return data[0].id
  }

  const name = hints.companyName?.trim()
  if (!name) return null
  const normalized = normalizeCompanyName(name)

  // History: previously filed certs with the same (normalized) insured name.
  // This is how the matcher learns names like "Affordable Gutters Plus
  // Siding and Insulation LLC" → the "Affordable Gutters" company after
  // staff assign it once. Requires every historical match to agree on ONE
  // company — a name that was ever filed two different ways stays manual.
  if (normalized.length >= 4) {
    const HISTORY_CAP = 1000
    const { data: history } = await admin
      .from("insurance_documents")
      .select("company_id, extracted_company_name")
      .eq("status", "processed")
      .not("company_id", "is", null)
      .not("extracted_company_name", "is", null)
      .ilike("extracted_company_name", `%${escapeLike(stripCompanySuffix(name).slice(0, 60))}%`)
      .limit(HISTORY_CAP)
    // Unanimity is only meaningful over the COMPLETE match set — if the
    // query hit its cap, a disagreeing assignment could sit past the cut,
    // so fall through to name matching instead of trusting a subset.
    if (history && history.length < HISTORY_CAP) {
      const agreed = new Set(
        history
          .filter(
            (d) => normalizeCompanyName(d.extracted_company_name ?? "") === normalized
          )
          .map((d) => d.company_id as string)
      )
      if (agreed.size === 1) return [...agreed][0]
    }
  }

  // Exact (case-insensitive) on name or AKA first.
  const { data: exact } = await admin
    .from("companies")
    .select("id")
    .or(`name.ilike.${escapeOrValue(name)},aka.ilike.${escapeOrValue(name)}`)
  if (exact && exact.length === 1) return exact[0].id

  // Then suffix-insensitive EQUALITY (never a contains-match — "ABC"
  // must not auto-assign to "ABC Plumbing"): strip "LLC"/"Inc"-style
  // suffixes and punctuation from both sides and require the full
  // normalized names to be identical. The ilike just narrows candidates;
  // the AKA gets the same treatment as the official name.
  const stripped = stripCompanySuffix(name)
  if (stripped.length >= 4) {
    const pattern = `%${escapeLike(stripped)}%`
    const { data: candidates } = await admin
      .from("companies")
      .select("id, name, aka")
      .or(`name.ilike.${escapeOrValue(pattern)},aka.ilike.${escapeOrValue(pattern)}`)
    const equal = (candidates ?? []).filter(
      (c) =>
        normalizeCompanyName(c.name) === normalized ||
        (c.aka && normalizeCompanyName(c.aka) === normalized)
    )
    if (equal.length === 1) return equal[0].id
  }
  return null
}

function stripCompanySuffix(s: string): string {
  return s.replace(/[,.]?\s*(llc|inc|corp|co|ltd)\.?$/i, "").trim()
}

function normalizeCompanyName(s: string): string {
  return stripCompanySuffix(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

// Values embedded in a PostgREST .or() filter can't contain unescaped commas
// or parens — quote the value so names like "Smith, Jones & Co" don't break
// the filter syntax.
function escapeOrValue(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

/** Pulls the bare address out of "Some Name <person@sub.com>" (or returns the input). */
export function parseEmailAddress(from?: string): string | null {
  if (!from) return null
  const angled = from.match(/<([^>]+)>/)
  const candidate = (angled ? angled[1] : from).trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)
    ? candidate.toLowerCase()
    : null
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (m) => `\\${m}`)
}

function extensionFor(fileType: string, fileName: string): string {
  const fromName = fileName.match(/(\.[a-z0-9]{2,5})$/i)?.[1]
  if (fromName) return fromName.toLowerCase()
  switch (fileType) {
    case "application/pdf":
      return ".pdf"
    case "image/jpeg":
      return ".jpg"
    case "image/png":
      return ".png"
    case "image/gif":
      return ".gif"
    case "image/webp":
      return ".webp"
    default:
      return ""
  }
}
