import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { extractCoi, isExtractableType, type CoiExtraction } from "./extract"
import type { Database, Json } from "@/lib/db/types"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Shared COI ingestion pipeline. All three entry points funnel here:
 *   - the Resend inbound-email webhook (source 'email')
 *   - the public tokenized sub upload page (source 'upload', company known)
 *   - staff manual upload from the Insurance page (source 'manual')
 *
 * Runs on the ADMIN client on purpose: the webhook and the public upload
 * route have no user session, and staff callers are gated by requireStaff()
 * before they get here. Steps: store the file → record the document →
 * extract with Claude → match a company → materialize policy rows. Every
 * failure mode lands as a document status ('failed' / 'needs_review')
 * instead of a thrown error, so webhooks don't retry-loop and the staff
 * dashboard shows what needs a human.
 */

type Admin = SupabaseClient<Database>

export const INSURANCE_BUCKET = "project-files"

export type InsuranceDocKind = "coi" | "w9" | "sma"

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
  // What kind of document this is. COIs (default) run Claude extraction and
  // materialize policy rows; W9s and Subcontractor Master Agreements are
  // stored as-is — with a company they're 'processed' immediately, without
  // one they land in the review queue for staff to assign.
  docKind?: InsuranceDocKind
}

export type IngestResult =
  | { ok: true; documentId: string; status: "processed" | "needs_review" | "failed" }
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

  const docKind = input.docKind ?? "coi"

  // 2. Record the document (status 'pending' until extraction lands).
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
      doc_kind: docKind,
      email_from: input.emailFrom ?? null,
      email_subject: input.emailSubject ?? null,
    })
    .select("id")
    .single()
  if (docErr || !doc) {
    return { ok: false, error: `Could not record document: ${docErr?.message}` }
  }

  // W9s and SMAs are plain documents — no extraction, no policy rows. With a
  // known company they're filed immediately; without one they queue for a
  // staff assign (the review card's company picker completes them).
  if (docKind !== "coi") {
    const status = input.companyId ? "processed" : "needs_review"
    const { error: updErr } = await admin
      .from("insurance_documents")
      .update({ status })
      .eq("id", doc.id)
    if (updErr) {
      return { ok: false, error: `Could not record document: ${updErr.message}` }
    }
    return { ok: true, documentId: doc.id, status }
  }

  // 3. Extract with Claude. Failures are recorded on the row, not thrown —
  // the file is safely stored, staff can see it and retry/assign manually.
  let extraction: CoiExtraction
  try {
    extraction = await extractCoi(bytes, input.fileType!)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await admin
      .from("insurance_documents")
      .update({ status: "failed", extraction_error: msg })
      .eq("id", doc.id)
    return { ok: true, documentId: doc.id, status: "failed" }
  }

  // 4. Resolve the company: explicit > email match > name match.
  let companyId = input.companyId ?? null
  if (!companyId) {
    companyId = await matchCompany(admin, {
      emailFrom: input.emailFrom,
      companyName: extraction.company_name,
    })
  }

  // 5. Persist the outcome.
  if (!companyId) {
    await admin
      .from("insurance_documents")
      .update({
        status: "needs_review",
        extracted_company_name: extraction.company_name,
        extraction: extraction as unknown as Json,
      })
      .eq("id", doc.id)
    return { ok: true, documentId: doc.id, status: "needs_review" }
  }

  try {
    await materializePolicies(admin, doc.id, companyId, extraction)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await admin
      .from("insurance_documents")
      .update({
        status: "failed",
        company_id: companyId,
        extracted_company_name: extraction.company_name,
        extraction: extraction as unknown as Json,
        extraction_error: msg,
      })
      .eq("id", doc.id)
    return { ok: true, documentId: doc.id, status: "failed" }
  }
  await admin
    .from("insurance_documents")
    .update({
      status: "processed",
      company_id: companyId,
      extracted_company_name: extraction.company_name,
      extraction: extraction as unknown as Json,
    })
    .eq("id", doc.id)
  await fillAgentContactFromExtraction(admin, companyId, extraction)
  return { ok: true, documentId: doc.id, status: "processed" }
}

/**
 * Backfills the company's insurance-agent contact (agency name / email /
 * phone) from the certificate's Producer block — but only fields that are
 * currently BLANK. Staff-entered values always win; a new cert never
 * overwrites them. Best-effort: a failure here never fails the ingest.
 */
export async function fillAgentContactFromExtraction(
  client: Admin,
  companyId: string,
  extraction: CoiExtraction
): Promise<void> {
  const name = extraction.producer_name?.trim()
  const email = extraction.producer_email?.trim()
  const phone = extraction.producer_phone?.trim()
  if (!name && !email && !phone) return
  try {
    const { data: company } = await client
      .from("companies")
      .select("id, insurance_agent_name, insurance_agent_email, insurance_agent_phone")
      .eq("id", companyId)
      .maybeSingle()
    if (!company) return
    const patch: {
      insurance_agent_name?: string
      insurance_agent_email?: string
      insurance_agent_phone?: string
    } = {}
    if (name && !company.insurance_agent_name?.trim()) {
      patch.insurance_agent_name = name
    }
    if (email && !company.insurance_agent_email?.trim()) {
      patch.insurance_agent_email = email
    }
    if (phone && !company.insurance_agent_phone?.trim()) {
      patch.insurance_agent_phone = phone
    }
    if (Object.keys(patch).length === 0) return
    const { error } = await client
      .from("companies")
      .update(patch)
      .eq("id", companyId)
    if (error) {
      console.warn("[insurance] agent-contact backfill failed:", error.message)
    }
  } catch (e) {
    console.warn("[insurance] agent-contact backfill failed:", e)
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
  extraction: CoiExtraction
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
    const { data: history } = await admin
      .from("insurance_documents")
      .select("company_id, extracted_company_name")
      .eq("status", "processed")
      .not("company_id", "is", null)
      .not("extracted_company_name", "is", null)
      .ilike("extracted_company_name", `%${escapeLike(stripCompanySuffix(name).slice(0, 60))}%`)
      .limit(50)
    const agreed = new Set(
      (history ?? [])
        .filter(
          (d) => normalizeCompanyName(d.extracted_company_name ?? "") === normalized
        )
        .map((d) => d.company_id as string)
    )
    if (agreed.size === 1) return [...agreed][0]
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
