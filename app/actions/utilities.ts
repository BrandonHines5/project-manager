"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireStaff } from "@/lib/auth"
import {
  CAW_BUILDER,
  CAW_FIXED,
  CAW_METER_SIZES,
  CAW_SUBMISSION_EMAIL,
  CAW_PAYMENT_URL,
  isCawConfigured,
} from "@/lib/utilities/caw/config"
import { fillCawForms, type CawRenderData } from "@/lib/utilities/caw/pdf"
import type { TablesInsert, TablesUpdate } from "@/lib/db/types"

const BUCKET = "project-files"
// Resend caps total message size ~40MB; stay well under it.
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

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
    .select("id, project_id, status, form_data, generated_file_paths")
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

  const { error: updErr } = await supabase
    .from("utility_requests")
    .update({ generated_file_paths: paths })
    .eq("id", requestId)
  if (updErr) throw new Error(updErr.message)

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
  await requireStaff()
  if (!isCawConfigured()) {
    return {
      sent: false,
      reason:
        "CAW builder details aren't configured yet (company name / TIN / contact). Fill them in before sending.",
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

  const form = CawForm.safeParse(req.form_data)
  if (!form.success) throw new Error(firstIssue(form.error))

  // Atomically CLAIM the draft (draft -> submitted) BEFORE the non-idempotent
  // email. Two concurrent senders both read "draft"; only the one whose
  // conditional update actually flips a row may proceed — so CAW is emailed once.
  const submittedAt = new Date().toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from("utility_requests")
    .update({ status: "submitted", submitted_at: submittedAt })
    .eq("id", requestId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle()
  if (claimErr) throw new Error(claimErr.message)
  if (!claimed) {
    return { sent: false, reason: "This request is already being submitted." }
  }

  // After claiming, any failure must roll the status back to draft for a retry.
  let result: { sent: boolean; reason?: string }
  try {
    // Download the stored PDFs and base64-encode for Resend.
    const store = await storageClient()
    const attachments: { filename: string; content: string }[] = []
    let total = 0
    for (const path of req.generated_file_paths) {
      const { data: blob, error: dlErr } = await store.storage.from(BUCKET).download(path)
      if (dlErr || !blob) throw new Error(`Could not read ${path}: ${dlErr?.message ?? "missing"}`)
      const buf = Buffer.from(await blob.arrayBuffer())
      total += buf.byteLength
      attachments.push({
        filename: path.split("/").pop() ?? "caw-form.pdf",
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

/** Walk a submitted request through the external pay-by-link steps. */
export async function updateUtilityStatus(input: z.input<typeof StatusInput>) {
  await requireStaff()
  const parsed = StatusInput.safeParse(input)
  if (!parsed.success) throw new Error(firstIssue(parsed.error))
  const { requestId, status } = parsed.data
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select("id, status")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) throw new Error("Request not found or not visible.")

  // Guard the workflow: each step only advances from the prior state.
  const allowed: Record<string, string> = {
    awaiting_payment: "submitted",
    paid: "awaiting_payment",
    complete: "paid",
  }
  if (req.status !== allowed[status]) {
    throw new Error(`Cannot move from "${req.status}" to "${status}".`)
  }

  const patch: TablesUpdate<"utility_requests"> = { status }
  if (status === "awaiting_payment") patch.payment_url = CAW_PAYMENT_URL
  if (status === "paid") patch.paid_at = new Date().toISOString()

  const { error: updErr } = await supabase
    .from("utility_requests")
    .update(patch)
    .eq("id", requestId)
  if (updErr) throw new Error(updErr.message)
  revalidatePath("/utilities")
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
