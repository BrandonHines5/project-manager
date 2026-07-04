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
      email_from: input.emailFrom ?? null,
      email_subject: input.emailSubject ?? null,
    })
    .select("id")
    .single()
  if (docErr || !doc) {
    return { ok: false, error: `Could not record document: ${docErr?.message}` }
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
  return { ok: true, documentId: doc.id, status: "processed" }
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
 * Best-effort company match for email ingestion. Email address is the
 * strongest signal (the sub usually sends from the address on file); the
 * extracted insured name is the fallback. Only returns a company when the
 * match is unambiguous — anything fuzzy goes to the review queue instead.
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
  if (name) {
    // Exact (case-insensitive) first.
    const { data: exact } = await admin
      .from("companies")
      .select("id")
      .ilike("name", name)
    if (exact && exact.length === 1) return exact[0].id

    // Then suffix-insensitive EQUALITY (never a contains-match — "ABC"
    // must not auto-assign to "ABC Plumbing"): strip "LLC"/"Inc"-style
    // suffixes and punctuation from both sides and require the full
    // normalized names to be identical. The ilike just narrows candidates.
    const stripped = stripCompanySuffix(name)
    if (stripped.length >= 4) {
      const { data: candidates } = await admin
        .from("companies")
        .select("id, name")
        .ilike("name", `%${escapeLike(stripped)}%`)
      const equal = (candidates ?? []).filter(
        (c) => normalizeCompanyName(c.name) === normalizeCompanyName(name)
      )
      if (equal.length === 1) return equal[0].id
    }
  }
  return null
}

function stripCompanySuffix(s: string): string {
  return s.replace(/[,.]?\s*(llc|inc|corp|co|ltd)\.?$/i, "").trim()
}

function normalizeCompanyName(s: string): string {
  return stripCompanySuffix(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
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
