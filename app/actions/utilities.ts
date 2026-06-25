"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import {
  CAW_BUILDER,
  CAW_FIXED,
  CAW_METER_SIZES,
  CAW_SUBMISSION_EMAIL,
  CAW_PAYMENT_URL,
  isCawConfigured,
  resolveCawZip,
} from "@/lib/utilities/caw/config"
import { fillCawForms, type CawRenderData } from "@/lib/utilities/caw/pdf"
import type { TablesInsert, TablesUpdate } from "@/lib/db/types"

const BUCKET = "project-files"
// Resend caps total message size ~40MB; stay well under it.
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

// Friendly email-attachment names per form key. Stored objects are named
// `{timestamp}-{key}.pdf`; CAW's intake reads these names, so present the real
// form titles rather than the internal storage filename.
const CAW_ATTACHMENT_NAMES: Record<string, string> = {
  new_service: "CAW-Request-For-Water-Service-Application.pdf",
  contract: "CAW-Water-Service-Contract.pdf",
  standpipe: "CAW-Temporary-Construction-Standpipe-Agreement.pdf",
}

/** Map a stored path (`…/{timestamp}-{key}.pdf`) to a friendly attachment name. */
function cawAttachmentName(path: string): string {
  const base = path.split("/").pop() ?? ""
  const key = base.replace(/\.pdf$/i, "").replace(/^\d+-/, "")
  return CAW_ATTACHMENT_NAMES[key] ?? (base || "caw-form.pdf")
}

/** Extract a 5-digit ZIP from a CRM value (string or number), else undefined. */
function coerceZip(v: unknown): string | undefined {
  if (v == null) return undefined
  const m = String(v).match(/\d{5}/)
  return m ? m[0] : undefined
}

// ---- Validation -----------------------------------------------------------

const CawForm = z.object({
  date: z.string().min(1, "Date is required"),
  serviceAddress: z.string().min(1, "Service address is required"),
  city: z.string().default(""),
  zip: z.string().default(""),
  subdivision: z.string().default(""),
  block: z.string().default(""),
  lot: z.string().default(""),
  existingWaterService: z.boolean().default(false),
  existingBuildings: z.string().default("0"),
  newBuildings: z.string().default("1"),
  multiStory: z.boolean().default(false),
  floors: z.string().default(""),
  multiFamily: z.boolean().default(false),
  unitsPerMeter: z.string().default(""),
  septicTank: z.boolean().default(false),
  publicSewer: z.boolean().default(true),
  squareFootage: z.string().default(""),
  meterSize: z.enum(CAW_METER_SIZES).default("5/8"),
  remarks: z.string().default(""),
  includeStandpipe: z.boolean().default(true),
})
export type CawFormT = z.infer<typeof CawForm>

const SaveInput = z.object({
  id: z.string().nullish(),
  project_id: z.string().min(1),
  form: CawForm,
})
export type SaveUtilityInputT = z.input<typeof SaveInput>

function firstIssue(error: z.ZodError): string {
  const f = error.issues[0]
  return `Invalid form data at ${f.path.join(".") || "(root)"}: ${f.message}`
}

/** Merge the per-job answers with the constant builder identity + fixed values. */
function toRenderData(form: CawFormT): CawRenderData {
  return {
    date: form.date,
    serviceAddress: form.serviceAddress,
    city: form.city,
    zip: form.zip,
    subdivision: form.subdivision,
    block: form.block,
    lot: form.lot,
    landUse: CAW_FIXED.landUse,
    typeOfService: CAW_FIXED.typeOfService,
    buildingType: CAW_FIXED.buildingType,
    meterSize: form.meterSize,
    existingWaterService: form.existingWaterService,
    existingBuildings: form.existingBuildings,
    newBuildings: form.newBuildings,
    multiStory: form.multiStory,
    floors: form.floors,
    multiFamily: form.multiFamily,
    unitsPerMeter: form.unitsPerMeter,
    septicTank: form.septicTank,
    publicSewer: form.publicSewer,
    remarks: form.remarks,
    applicantName: CAW_BUILDER.companyName,
    tin: CAW_BUILDER.tin,
    phone: CAW_BUILDER.businessPhone,
    altPhone: CAW_BUILDER.altPhone,
    email: CAW_BUILDER.email,
    fax: "",
    mailingAddress: CAW_BUILDER.mailingAddress,
    preparerName: CAW_BUILDER.preparerName,
    includeStandpipe: form.includeStandpipe,
  }
}

// ---- Actions --------------------------------------------------------------

/** Create or update a draft utility request (CAW). Returns the row id. */
export async function saveUtilityDraft(input: SaveUtilityInputT): Promise<{ id: string }> {
  const profile = await requireStaff()
  const parsed = SaveInput.safeParse(input)
  if (!parsed.success) throw new Error(firstIssue(parsed.error))
  const { id, project_id, form } = parsed.data
  const supabase = await createSupabaseServerClient()

  // Confirm the project is visible to this staff member (RLS-scoped).
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", project_id)
    .maybeSingle()
  if (!project) throw new Error("Project not found or not visible.")

  if (id) {
    // Editing the answers invalidates any previously generated PDFs, so clear
    // generated_file_paths — otherwise a later send could attach stale forms.
    // Capture the prior paths first so we can also delete the orphaned objects
    // from storage after the row is updated.
    const { data: existing } = await supabase
      .from("utility_requests")
      .select("generated_file_paths")
      .eq("id", id)
      .eq("project_id", project_id)
      .eq("status", "draft")
      .maybeSingle()

    // Scope to the same project + draft status, and confirm a row was updated.
    const { data: updated, error } = await supabase
      .from("utility_requests")
      .update({ form_data: form, generated_file_paths: [] })
      .eq("id", id)
      .eq("project_id", project_id)
      .eq("status", "draft") // only drafts are editable
      .select("id")
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!updated) {
      throw new Error("Draft not found, not editable, or project mismatch.")
    }
    // Best-effort cleanup of the now-orphaned PDF objects. Done after the DB
    // update so a storage hiccup never blocks the save; the rows are already
    // gone from generated_file_paths.
    const stale = existing?.generated_file_paths ?? []
    if (stale.length) {
      const store = await storageClient()
      const { error: rmErr } = await store.storage.from(BUCKET).remove(stale)
      if (rmErr) console.warn("[saveUtilityDraft] could not remove old PDFs:", rmErr.message)
    }
    revalidatePath("/utilities")
    return { id }
  }

  const row: TablesInsert<"utility_requests"> = {
    project_id,
    provider: "central_arkansas_water",
    status: "draft",
    form_data: form,
    created_by: profile.id,
  }
  const { data, error } = await supabase
    .from("utility_requests")
    .insert(row)
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidatePath("/utilities")
  return { id: data.id }
}

/** Storage client: prefer service-role (avoids any server-context storage RLS
 * surprises); the action is already gated by requireStaff(). Falls back to the
 * caller's session client when the service key isn't configured. */
async function storageClient() {
  return createSupabaseAdminClient() ?? (await createSupabaseServerClient())
}

/**
 * Generate (or regenerate) the filled CAW PDFs for a draft request, store them
 * in the project-files bucket, and return signed preview URLs. Idempotent —
 * regenerating replaces the previous file set.
 */
export async function generateCawPdfs({
  requestId,
}: {
  requestId: string
}): Promise<{ files: { key: string; filename: string; path: string; url: string }[] }> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select("id, project_id, status, form_data, generated_file_paths, updated_at")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) throw new Error("Request not found or not visible.")
  // Only drafts may (re)generate — never replace the official attachments of a
  // request that has already been submitted/paid.
  if (req.status !== "draft") {
    throw new Error("Only draft requests can generate PDFs.")
  }

  const form = CawForm.safeParse(req.form_data)
  if (!form.success) throw new Error(firstIssue(form.error))

  const filled = await fillCawForms(toRenderData(form.data))

  const store = await storageClient()
  const priorPaths = req.generated_file_paths ?? []

  const ts = Date.now()
  const out: { key: string; filename: string; path: string; url: string }[] = []
  const paths: string[] = []
  for (const f of filled) {
    const path = `projects/${req.project_id}/utilities/caw/${ts}-${f.key}.pdf`
    const { error: upErr } = await store.storage
      .from(BUCKET)
      .upload(path, Buffer.from(f.bytes), {
        contentType: "application/pdf",
        upsert: true,
      })
    if (upErr) throw new Error(`Upload failed for ${f.filename}: ${upErr.message}`)
    paths.push(path)
    out.push({ key: f.key, filename: f.filename, path, url: "" })
  }

  // Commit the new paths only if the draft hasn't changed since we loaded it
  // (updated_at unchanged). If another staff member saved the draft mid-render,
  // abort and discard our uploads so we never attach PDFs built from superseded
  // answers.
  const { data: committed, error: updErr } = await supabase
    .from("utility_requests")
    .update({ generated_file_paths: paths })
    .eq("id", requestId)
    .eq("status", "draft")
    .eq("updated_at", req.updated_at)
    .select("id")
    .maybeSingle()
  if (updErr) throw new Error(updErr.message)
  if (!committed) {
    await store.storage.from(BUCKET).remove(paths)
    throw new Error("This draft changed while generating — please regenerate.")
  }

  // Only now that the new set is committed do we delete the old objects, so a
  // mid-generation failure leaves the prior PDFs (and their DB paths) intact.
  if (priorPaths.length) {
    const stale = priorPaths.filter((p) => !paths.includes(p))
    if (stale.length) {
      const { error: rmErr } = await store.storage.from(BUCKET).remove(stale)
      if (rmErr) console.warn("[generateCawPdfs] could not remove old PDFs:", rmErr.message)
    }
  }

  const urls = await getUtilitySignedUrls(paths)
  for (const o of out) o.url = urls[o.path] ?? ""

  revalidatePath("/utilities")
  return { files: out }
}

/** Email the generated CAW forms to CAW's new-construction intake. */
export async function sendCawForms({
  requestId,
}: {
  requestId: string
}): Promise<{ sent: boolean; reason?: string }> {
  const sender = await requireStaff()
  if (!isCawConfigured()) {
    return {
      sent: false,
      reason:
        "CAW builder details aren't configured yet (company name, phone, email, mailing address). Fill them in before sending.",
    }
  }
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select("id, project_id, status, form_data, generated_file_paths")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) throw new Error("Request not found or not visible.")
  if (req.status !== "draft") {
    return { sent: false, reason: "This request has already been submitted." }
  }
  if (!req.generated_file_paths?.length) {
    return { sent: false, reason: "Generate the forms before sending." }
  }

  // Atomically CLAIM the draft (draft -> submitted) BEFORE the non-idempotent
  // email. Two concurrent senders both read "draft"; only the one whose
  // conditional update actually flips a row may proceed — so CAW is emailed once.
  // Read the canonical form_data + paths back FROM the claim so a concurrent
  // draft save (which clears the paths) can't slip stale PDFs past us.
  const submittedAt = new Date().toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from("utility_requests")
    .update({ status: "submitted", submitted_at: submittedAt })
    .eq("id", requestId)
    .eq("status", "draft")
    .select("id, form_data, generated_file_paths")
    .maybeSingle()
  if (claimErr) throw new Error(claimErr.message)
  if (!claimed) {
    return { sent: false, reason: "This request is already being submitted." }
  }

  // After claiming, any failure must roll the status back to draft for a retry.
  let result: { sent: boolean; reason?: string }
  try {
    if (!claimed.generated_file_paths?.length) {
      throw new Error("Generate the forms before sending.")
    }
    const form = CawForm.safeParse(claimed.form_data)
    if (!form.success) throw new Error(firstIssue(form.error))

    // Download the stored PDFs and base64-encode for Resend.
    const store = await storageClient()
    const attachments: { filename: string; content: string }[] = []
    let total = 0
    for (const path of claimed.generated_file_paths) {
      const { data: blob, error: dlErr } = await store.storage.from(BUCKET).download(path)
      if (dlErr || !blob) throw new Error(`Could not read ${path}: ${dlErr?.message ?? "missing"}`)
      const buf = Buffer.from(await blob.arrayBuffer())
      total += buf.byteLength
      attachments.push({
        filename: cawAttachmentName(path),
        content: buf.toString("base64"),
      })
    }
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw new Error("Generated forms are too large to email. Contact support.")
    }

    const addr = form.data.serviceAddress
    const lines = [
      "Please find attached the New Service application for a new construction water service request.",
      "",
      `Service address: ${addr}${form.data.city ? `, ${form.data.city}` : ""}${form.data.zip ? ` ${form.data.zip}` : ""}`,
      `Applicant: ${CAW_BUILDER.companyName}`,
      form.data.includeStandpipe
        ? "A temporary construction standpipe is requested (see attached agreement)."
        : "",
      "",
      "Attached:",
      "  - Request For Water Service Application",
      "  - Water Service Contract",
      form.data.includeStandpipe ? "  - Agreement for Temporary Construction Standpipe" : "",
      "",
      "Thank you,",
      CAW_BUILDER.companyName,
    ].filter((l) => l !== "")

    const { sendEmail } = await import("@/lib/email")
    result = await sendEmail({
      to: CAW_SUBMISSION_EMAIL,
      // CC the staff member who sent it so they get a copy as confirmation, and
      // set them as Reply-To so CAW's response comes back to their inbox (the
      // From address is a send-only Resend sender).
      cc: sender.email ?? undefined,
      replyTo: sender.email ?? undefined,
      subject: `New Water Service Request - ${addr}`,
      text: lines.join("\n"),
      attachments,
    })
  } catch (e) {
    result = { sent: false, reason: e instanceof Error ? e.message : "Send failed." }
  }

  if (!result.sent) {
    // Roll the claim back so the request returns to draft and can be retried.
    await supabase
      .from("utility_requests")
      .update({ status: "draft", submitted_at: null })
      .eq("id", requestId)
      .eq("status", "submitted")
  }
  revalidatePath("/utilities")
  return result
}

const StatusInput = z.object({
  requestId: z.string().min(1),
  status: z.enum(["awaiting_payment", "paid", "complete"]),
})

/**
 * Walk a submitted request through the external pay-by-link steps. Returns a
 * typed result (not a throw) for the user-facing guards, because Next.js
 * redacts thrown server-action error messages in production — so the operator
 * would otherwise see a generic "Update failed." instead of the real reason.
 */
export async function updateUtilityStatus(
  input: z.input<typeof StatusInput>
): Promise<{ ok: boolean; error?: string }> {
  await requireStaff()
  const parsed = StatusInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const { requestId, status } = parsed.data
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select("id, status")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) return { ok: false, error: "Request not found or not visible." }

  // Guard the workflow: each step only advances from the prior state.
  const allowed: Record<string, string> = {
    awaiting_payment: "submitted",
    paid: "awaiting_payment",
    complete: "paid",
  }
  if (req.status !== allowed[status]) {
    return { ok: false, error: `Cannot move from "${req.status}" to "${status}".` }
  }

  const patch: TablesUpdate<"utility_requests"> = { status }
  if (status === "awaiting_payment") patch.payment_url = CAW_PAYMENT_URL
  if (status === "paid") patch.paid_at = new Date().toISOString()

  // Bind to the expected prior state so a concurrent transition can't double-apply.
  const { data: updated, error: updErr } = await supabase
    .from("utility_requests")
    .update(patch)
    .eq("id", requestId)
    .eq("status", allowed[status])
    .select("id")
    .maybeSingle()
  if (updErr) throw new Error(updErr.message)
  if (!updated) {
    return { ok: false, error: "This request just changed — refresh and try again." }
  }
  revalidatePath("/utilities")
  return { ok: true }
}

export type CawPrefill = {
  serviceAddress?: string
  city?: string
  zip?: string
  subdivision?: string
  block?: string
  lot?: string
  squareFootage?: string
  multiStory?: boolean
  floors?: string
  /** "crm" when matched in the CRM, "none" when it fell back to the local data. */
  source: "crm" | "none"
}

/**
 * Pull extra property details from the Hines Homes CRM (matched by
 * project_number) to pre-fill the CAW form: city, subdivision, lot/block,
 * square footage, and floor count. Best-effort — returns source:"none" (with
 * just the local address) when the CRM isn't configured or has no matching row.
 * Note: the CRM has no ZIP column, so ZIP is left for the user to enter.
 */
export async function getCawPrefill({
  projectId,
}: {
  projectId: string
}): Promise<CawPrefill> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: project } = await supabase
    .from("projects")
    .select("project_number, address")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return { source: "none" }

  const fallback: CawPrefill = {
    serviceAddress: project.address ?? undefined,
    source: "none",
  }
  const crm = createCrmClient()
  if (!crm || !project.project_number) return fallback

  // select("*") so we pick up a ZIP column whatever it's named in the view
  // (zip / zip_code / postal_code), and so a not-yet-added column never errors
  // the query — it just comes back undefined.
  const { data, error } = await crm
    .from("projects_dashboard_full")
    .select("*")
    .eq("project_number", project.project_number)
    .maybeSingle()
  if (error || !data) return fallback

  const row = data as {
    street_address: string | null
    city: string | null
    lot_block: string | null
    subdivision_name: string | null
    total_area_without_veneer: number | null
    total_area_with_veneer: number | null
    floors: number | null
    zip?: string | number | null
    zip_code?: string | number | null
    postal_code?: string | number | null
    zipcode?: string | number | null
  }
  // lot_block is stored as "{lot}-{block}" (e.g. "15-1").
  let lot = ""
  let block = ""
  if (row.lot_block) {
    const parts = row.lot_block.split(/[-/]/).map((s) => s.trim())
    lot = parts[0] ?? ""
    block = parts[1] ?? ""
  }
  const sqft = row.total_area_without_veneer ?? row.total_area_with_veneer
  const floors = row.floors
  // Prefer a ZIP stored on the CRM record; fall back to the subdivision/city
  // lookup table for projects whose CRM ZIP isn't filled in yet.
  const zip =
    [row.zip, row.zip_code, row.postal_code, row.zipcode]
      .map(coerceZip)
      .find((value): value is string => Boolean(value)) ??
    resolveCawZip({ subdivision: row.subdivision_name, city: row.city })
  return {
    serviceAddress: row.street_address ?? project.address ?? undefined,
    city: row.city ?? undefined,
    zip,
    subdivision: row.subdivision_name ?? undefined,
    block: block || undefined,
    lot: lot || undefined,
    squareFootage: sqft != null ? String(Math.round(sqft)) : undefined,
    multiStory: floors != null ? floors > 1 : undefined,
    floors: floors != null && floors > 1 ? String(floors) : undefined,
    source: "crm",
  }
}

/** Sign storage paths for preview/download (1hr). */
export async function getUtilitySignedUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}
