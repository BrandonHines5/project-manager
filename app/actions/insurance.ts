"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendEmail, appUrl } from "@/lib/email"
import {
  buildInsuranceRequestEmail,
  insuranceReplyTo,
} from "@/lib/insurance/reminder-email"
import { isRequiredInsuranceType } from "@/lib/insurance/requirements"
import {
  ingestInsuranceDocument,
  materializePolicies,
  fillAgentContactFromExtraction,
  INSURANCE_BUCKET,
} from "@/lib/insurance/ingest"
import type { CoiExtraction } from "@/lib/insurance/extract"

const INSURANCE_PATH = "/companies/insurance"
const Uuid = z.string().uuid()

/**
 * Staff manual upload, mirroring the daily-logs pattern: the browser puts
 * the file straight into Storage with the user's JWT (staff storage RLS),
 * then calls this with the path. Ingestion (extraction + policy rows) runs
 * server-side from the stored object.
 */
export async function processStoredInsuranceDocument(input: {
  storagePath: string
  fileName: string
  fileType: string
  fileSize: number
  companyId?: string | null
  docKind?: "coi" | "w9" | "sma"
}) {
  await requireStaff()
  const parsed = z
    .object({
      storagePath: z
        .string()
        .regex(/^companies\/insurance\/[A-Za-z0-9._-]+$/, "Unexpected storage path"),
      fileName: z.string().min(1).max(300),
      fileType: z.string().min(1).max(100),
      fileSize: z.number().int().positive(),
      companyId: Uuid.nullish(),
      docKind: z.enum(["coi", "w9", "sma"]).optional(),
    })
    .parse(input)

  const result = await ingestInsuranceDocument({
    storagePath: parsed.storagePath,
    fileName: parsed.fileName,
    fileType: parsed.fileType,
    fileSize: parsed.fileSize,
    source: "manual",
    companyId: parsed.companyId ?? undefined,
    docKind: parsed.docKind ?? "coi",
  })
  revalidatePath(INSURANCE_PATH)
  return result
}

/**
 * Resolves a needs-review document: attaches it to the chosen company and
 * materializes the policies Claude already extracted (stored on the row —
 * no second model call).
 */
export async function assignInsuranceDocument(documentId: string, companyId: string) {
  await requireStaff()
  Uuid.parse(documentId)
  Uuid.parse(companyId)
  const supabase = await createSupabaseServerClient()

  const { data: doc, error } = await supabase
    .from("insurance_documents")
    .select("id, extraction")
    .eq("id", documentId)
    .single()
  if (error || !doc) throw new Error(error?.message ?? "Document not found")

  const extraction = (doc.extraction ?? {
    company_name: null,
    policies: [],
  }) as unknown as CoiExtraction

  // Staff client, not admin: staff RLS covers these writes, and keeping the
  // caller's session means RLS stays the source of truth.
  await materializePolicies(supabase, documentId, companyId, extraction)

  const { error: updErr } = await supabase
    .from("insurance_documents")
    .update({ status: "processed", company_id: companyId })
    .eq("id", documentId)
  if (updErr) throw new Error(updErr.message)
  // Capture the cert's Producer (agency) contact onto the company's blank
  // agent fields — the manual-assign path should teach the directory just
  // like the auto-match path does.
  await fillAgentContactFromExtraction(supabase, companyId, extraction)
  revalidatePath(INSURANCE_PATH)
}

/**
 * Deletes a document plus everything derived from it: its policy rows and
 * the stored file. Used when a junk email lands in the queue or the wrong
 * file was uploaded.
 */
export async function deleteInsuranceDocument(documentId: string) {
  await requireStaff()
  Uuid.parse(documentId)
  const supabase = await createSupabaseServerClient()

  const { data: doc, error } = await supabase
    .from("insurance_documents")
    .select("id, storage_path")
    .eq("id", documentId)
    .single()
  if (error || !doc) throw new Error(error?.message ?? "Document not found")

  // Policies first, then the document, and only then the stored file. Not
  // transactional, but every failure point leaves a retriable state: if the
  // document delete fails after the policies are gone, the row is still
  // visible on the dashboard and a second "Delete" completes the job.
  const { error: polErr } = await supabase
    .from("insurance_policies")
    .delete()
    .eq("document_id", documentId)
  if (polErr) throw new Error(polErr.message)

  const { error: delErr } = await supabase
    .from("insurance_documents")
    .delete()
    .eq("id", documentId)
  if (delErr) throw new Error(delErr.message)

  const { error: fileErr } = await supabase.storage
    .from(INSURANCE_BUCKET)
    .remove([doc.storage_path])
  if (fileErr) {
    // DB is already consistent; an orphaned storage object is a cleanup
    // nit, not a reason to fail the action.
    console.warn("[insurance] storage remove failed:", fileErr.message)
  }
  revalidatePath(INSURANCE_PATH)
}

/** Removes a single mis-extracted policy row. The source document stays. */
export async function deleteInsurancePolicy(policyId: string) {
  await requireStaff()
  Uuid.parse(policyId)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("insurance_policies")
    .delete()
    .eq("id", policyId)
  if (error) throw new Error(error.message)
  revalidatePath(INSURANCE_PATH)
}

/** 1-hour signed URL for viewing a stored certificate. */
export async function getInsuranceDocumentUrl(documentId: string) {
  await requireStaff()
  Uuid.parse(documentId)
  const supabase = await createSupabaseServerClient()
  const { data: doc, error } = await supabase
    .from("insurance_documents")
    .select("storage_path")
    .eq("id", documentId)
    .single()
  if (error || !doc) throw new Error(error?.message ?? "Document not found")
  const { data, error: urlErr } = await supabase.storage
    .from(INSURANCE_BUCKET)
    .createSignedUrl(doc.storage_path, 3600)
  if (urlErr || !data) throw new Error(urlErr?.message ?? "Could not sign URL")
  return data.signedUrl
}

/**
 * On-demand "please send us your certificate" email — the same message the
 * cron sends, minus the 7-day window. Lists whatever current policies are
 * expiring or expired; for a company with nothing on file it asks for a
 * cert outright. Ignores notifications_enabled on purpose: an explicit
 * button click is a deliberate staff decision, unlike the automated cron.
 */
export async function sendInsuranceRequest(companyId: string): Promise<{
  sent: boolean
  reason?: string
}> {
  const profile = await requireStaff()
  Uuid.parse(companyId)
  const supabase = await createSupabaseServerClient()

  const { data: company, error } = await supabase
    .from("companies")
    .select(
      "id, name, email, contact_name, insurance_upload_token, insurance_agent_email"
    )
    .eq("id", companyId)
    .single()
  if (error || !company) {
    return { sent: false, reason: error?.message ?? "Company not found" }
  }
  if (!company.email && !company.insurance_agent_email) {
    return {
      sent: false,
      reason: "No email on file for this company or its insurance agent",
    }
  }

  // Current policy per type; mention the ones expiring within 30 days or
  // already lapsed so the email names what's wrong.
  const { data: policies } = await supabase
    .from("insurance_policies")
    .select("type, expiration_date")
    .eq("company_id", companyId)
  const latest = new Map<string, string>()
  for (const p of policies ?? []) {
    const prev = latest.get(p.type)
    if (!prev || p.expiration_date > prev) latest.set(p.type, p.expiration_date)
  }
  const soon = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)
  // Only list REQUIRED coverages (GL/WC) — auto/umbrella are tracked but not
  // chased, so they don't appear in the request email.
  const expiring = Array.from(latest.entries())
    .filter(([type, exp]) => isRequiredInsuranceType(type) && exp <= soon)
    .map(([type, expiration_date]) => ({ type, expiration_date }))

  const message = buildInsuranceRequestEmail({
    companyName: company.name,
    contactName: company.contact_name,
    expiring,
    uploadUrl: appUrl(`/insurance-upload/${company.insurance_upload_token}`),
  })
  const replyTo = insuranceReplyTo()
  // The request goes to the sub AND their insurance agent when an agent
  // email is on file — the agent usually issues the certificate anyway. A
  // company with only an agent email still gets the request (agent as To).
  const agentEmail = company.insurance_agent_email?.trim() || null
  const to = company.email ?? agentEmail!
  const cc = company.email && agentEmail && agentEmail !== company.email ? agentEmail : undefined
  return sendEmail({
    to,
    ...(cc ? { cc } : {}),
    // Replies (usually with the cert attached) route to the inbound
    // pipeline instead of bouncing off the send-only From address.
    ...(replyTo ? { replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html,
    // Company-scoped (no project) — shows in the global staff hub only.
    log: {
      company_id: company.id,
      sent_by: profile.id,
      kind: "insurance_request",
      counterparty_name: company.name,
    },
  })
}
