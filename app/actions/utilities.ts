"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import { CAW_FIXED, CAW_METER_SIZES } from "@/lib/utilities/caw/config"
import {
  getUtilityConfig,
  isCawConfigured,
  isLumberOneConfigured,
  resolveCawZip,
  resolveCounty,
  defaultDeliveryDirections,
  type UtilityOrgConfig,
} from "@/lib/utilities/org-config"
import { getActiveOrgId, isLegacyActiveOrg, LEGACY_ORG_ID } from "@/lib/org"
import { fillCawForms, type CawRenderData } from "@/lib/utilities/caw/pdf"
import {
  fillLumberOneForms,
  type LumberOneRenderData,
} from "@/lib/utilities/lumber-one/pdf"
import type { FilledPdf } from "@/lib/utilities/fill"
import type { Enums, TablesInsert, TablesUpdate } from "@/lib/db/types"

export type UtilityProvider = Enums<"utility_provider">

const BUCKET = "project-files"
// Resend caps total message size ~40MB; stay well under it.
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

// Friendly email-attachment names per form key. Stored objects are named
// `{timestamp}-{key}.pdf`; the recipients read these names, so present the
// real form titles rather than the internal storage filename.
const ATTACHMENT_NAMES: Record<string, string> = {
  new_service: "CAW-Request-For-Water-Service-Application.pdf",
  contract: "CAW-Water-Service-Contract.pdf",
  standpipe: "CAW-Temporary-Construction-Standpipe-Agreement.pdf",
  new_job_setup: "Lumber-One-New-Job-Set-Up-Request.pdf",
}

/** Map a stored path (`…/{timestamp}-{key}.pdf`) to a friendly attachment name. */
function attachmentName(path: string): string {
  const base = path.split("/").pop() ?? ""
  const key = base.replace(/\.pdf$/i, "").replace(/^\d+-/, "")
  return ATTACHMENT_NAMES[key] ?? (base || "form.pdf")
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

// The Lumber One "New Job Set-Up Request Form". Salesperson Initials/Number,
// Acct #, Bond Type, and Estimated Sales are intentionally absent — they stay
// blank on the form for Brad to fill in (see lib/utilities/lumber-one/config).
const LumberForm = z.object({
  date: z.string().min(1, "Date is required"),
  jobName: z.string().default(""),
  streetAddress: z.string().min(1, "Street address is required"),
  city: z.string().default(""),
  zip: z.string().default(""),
  county: z.string().default(""),
  subdivision: z.string().default(""),
  lot: z.string().default(""),
  inCityLimits: z.boolean().default(false),
  propertyOwner: z.string().default(""),
  deliveryDirections: z.string().default(""),
})
export type LumberFormT = z.infer<typeof LumberForm>

// One provider's answers within a save. `id` continues that provider's
// existing draft; omitted/null starts a new one.
const SaveEntry = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("central_arkansas_water"),
    id: z.string().nullish(),
    form: CawForm,
  }),
  z.object({
    provider: z.literal("lumber_one"),
    id: z.string().nullish(),
    form: LumberForm,
  }),
])
export type SaveEntryT = z.input<typeof SaveEntry>

// A request's job can live in this app (project_id), in the CRM
// (crm_project_id), or both — the dropdown is sourced from the CRM, where most
// active jobs have no local project row yet. Multiple providers can be saved
// in one call (the UI multi-selects CAW / Lumber One), each as its own row.
const SaveInput = z
  .object({
    project_id: z.string().nullish(),
    crm_project_id: z.string().nullish(),
    entries: z.array(SaveEntry).min(1, "Pick at least one form to fill out."),
  })
  .refine((v) => v.project_id || v.crm_project_id, {
    message: "Pick a job first.",
  })
  .refine(
    (v) => new Set(v.entries.map((e) => e.provider)).size === v.entries.length,
    { message: "Duplicate provider in save request." }
  )
export type SaveUtilityInputT = z.input<typeof SaveInput>

function firstIssue(error: z.ZodError): string {
  const f = error.issues[0]
  return `Invalid form data at ${f.path.join(".") || "(root)"}: ${f.message}`
}

/** Merge the per-job answers with the org's customer identity. */
function toLumberRenderData(
  form: LumberFormT,
  cfg: UtilityOrgConfig
): LumberOneRenderData {
  return {
    date: form.date,
    customerName: cfg.builder.companyName,
    jobName: form.jobName,
    lot: form.lot,
    subdivision: form.subdivision,
    streetAddress: form.streetAddress,
    city: form.city,
    zip: form.zip,
    county: form.county,
    inCityLimits: form.inCityLimits,
    propertyOwner: form.propertyOwner,
    deliveryDirections: form.deliveryDirections,
  }
}

/** Merge the per-job answers with the org's builder identity + fixed values. */
function toRenderData(form: CawFormT, cfg: UtilityOrgConfig): CawRenderData {
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
    applicantName: cfg.builder.companyName,
    tin: cfg.builder.tin,
    phone: cfg.builder.businessPhone,
    altPhone: cfg.builder.altPhone,
    email: cfg.builder.email,
    fax: "",
    mailingAddress: cfg.builder.mailingAddress,
    preparerName: cfg.builder.preparerName,
    includeStandpipe: form.includeStandpipe,
  }
}

// ---- Actions --------------------------------------------------------------

/**
 * Resolve the job a request points at — server-side, never trusting the
 * client's pairing. For a CRM job we re-derive the local project link (shared
 * key: project_number) and snapshot a display label; for a local-only job the
 * label comes from the projects row.
 */
async function resolveJob(
  input: {
    project_id?: string | null
    crm_project_id?: string | null
  },
  // Active-org boundary: a multi-org staffer must not pair a request with a
  // project from an org they merely belong to — the row stamps the ACTIVE
  // org, so the job has to live there too.
  orgId: string
): Promise<{ projectId: string | null; crmProjectId: string | null; jobLabel: string }> {
  const supabase = await createSupabaseServerClient()

  if (input.crm_project_id) {
    // The CRM is Hines Homes' external system — only the legacy org may pair a
    // request with a CRM job. orgId is already the caller's ACTIVE org here.
    if (orgId !== LEGACY_ORG_ID) {
      throw new Error("CRM jobs are only available for Hines Homes.")
    }
    const crm = createCrmClient()
    if (!crm) {
      throw new Error(
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel."
      )
    }
    const { data, error } = await crm
      .from("projects")
      .select("id, project_number, street_address, city, client_name")
      .eq("id", input.crm_project_id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new Error("That CRM job could not be found.")
    const row = data as {
      id: string
      project_number: string | null
      street_address: string | null
      city: string | null
      client_name: string | null
    }
    // Link the local project too when one shares the job's project_number —
    // only within the active org (the CRM itself is a legacy org-#1 system,
    // but the local link must respect the boundary).
    let projectId: string | null = null
    if (row.project_number) {
      const { data: local } = await supabase
        .from("projects")
        .select("id")
        .eq("project_number", row.project_number)
        .eq("org_id", orgId)
        .limit(1)
        .maybeSingle()
      projectId = local?.id ?? null
    }
    const place = row.street_address?.trim() || row.city?.trim() || "Unknown address"
    const client = row.client_name?.trim()
    return {
      projectId,
      crmProjectId: row.id,
      jobLabel: `${row.project_number ?? "?"} — ${place}${client ? ` (${client})` : ""}`,
    }
  }

  // Local-only job: confirm it's visible to this staff member (RLS-scoped)
  // AND belongs to their active org.
  const { data: project } = await supabase
    .from("projects")
    .select("id, project_number, name")
    .eq("id", input.project_id!)
    .eq("org_id", orgId)
    .maybeSingle()
  if (!project) throw new Error("Project not found or not visible.")
  return {
    projectId: project.id,
    crmProjectId: null,
    jobLabel: `${project.project_number} — ${project.name}`,
  }
}

/**
 * Create or update draft utility requests — one row per selected provider,
 * saved in a single call so the UI can fill CAW and Lumber One together.
 * The entries are independent rows (no transaction), so one provider's
 * failure must NOT throw away another's committed id — the caller would
 * lose track of the row and insert a duplicate draft on retry. Each entry
 * reports its own id or error instead.
 */
export async function saveUtilityDrafts(
  input: SaveUtilityInputT
): Promise<{
  ids: Partial<Record<UtilityProvider, string>>
  errors: Partial<Record<UtilityProvider, string>>
}> {
  const profile = await requireStaff()
  const parsed = SaveInput.safeParse(input)
  if (!parsed.success) throw new Error(firstIssue(parsed.error))
  const supabase = await createSupabaseServerClient()

  // New drafts stamp the acting staffer's org (0113 dropped the bridge
  // default). Resolved once — every entry in the call belongs to the same
  // user, so the same org — and BEFORE resolveJob so the job is validated
  // against the same boundary the row will be stamped with.
  const orgId = await getActiveOrgId(supabase, profile.id)
  const job = await resolveJob(parsed.data, orgId)

  const ids: Partial<Record<UtilityProvider, string>> = {}
  const errors: Partial<Record<UtilityProvider, string>> = {}
  for (const entry of parsed.data.entries) {
    try {
      ids[entry.provider] = await saveOneDraft(supabase, profile.id, orgId, entry, job)
    } catch (e) {
      errors[entry.provider] = e instanceof Error ? e.message : "Save failed."
    }
  }
  revalidatePath("/utilities")
  return { ids, errors }
}

async function saveOneDraft(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  createdBy: string,
  orgId: string,
  entry: z.infer<typeof SaveEntry>,
  job: { projectId: string | null; crmProjectId: string | null; jobLabel: string }
): Promise<string> {
  const { provider, id, form } = entry
  const { projectId, crmProjectId, jobLabel } = job

  if (id) {
    // Editing the answers invalidates any previously generated PDFs, so clear
    // generated_file_paths — otherwise a later send could attach stale forms.
    // Capture the prior paths first so we can also delete the orphaned objects
    // from storage after the row is updated.
    const { data: existing } = await supabase
      .from("utility_requests")
      .select("org_id, project_id, crm_project_id, provider, generated_file_paths")
      .eq("id", id)
      .eq("status", "draft")
      .maybeSingle()
    if (!existing) throw new Error("Draft not found or not editable.")
    if (existing.org_id !== orgId) {
      // A multi-org staffer can't edit another org's draft from this one.
      throw new Error("Draft not found or not editable.")
    }
    if (existing.provider !== provider) {
      throw new Error("Draft not found, not editable, or provider mismatch.")
    }

    // The draft must still reference the SAME job on at least one link — a
    // pre-CRM draft carries only project_id, a CRM-sourced one only/also
    // crm_project_id. Updating then upgrades the row to the full linkage.
    const sameJob =
      (crmProjectId && existing.crm_project_id === crmProjectId) ||
      (projectId && existing.project_id === projectId)
    if (!sameJob) throw new Error("Draft not found, not editable, or job mismatch.")

    const { data: updated, error } = await supabase
      .from("utility_requests")
      .update({
        form_data: form,
        generated_file_paths: [],
        project_id: projectId,
        crm_project_id: crmProjectId ?? existing.crm_project_id,
        job_label: jobLabel,
      })
      .eq("id", id)
      .eq("status", "draft") // only drafts are editable
      .eq("org_id", orgId)
      .select("id")
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!updated) {
      throw new Error("Draft not found, not editable, or job mismatch.")
    }
    // Best-effort cleanup of the now-orphaned PDF objects. Done after the DB
    // update so a storage hiccup never blocks the save; the rows are already
    // gone from generated_file_paths.
    const stale = existing?.generated_file_paths ?? []
    if (stale.length) {
      const store = await storageClient()
      const { error: rmErr } = await store.storage.from(BUCKET).remove(stale)
      if (rmErr) console.warn("[saveUtilityDrafts] could not remove old PDFs:", rmErr.message)
    }
    return id
  }

  const row: TablesInsert<"utility_requests"> = {
    project_id: projectId,
    crm_project_id: crmProjectId,
    job_label: jobLabel,
    provider,
    status: "draft",
    form_data: form,
    created_by: createdBy,
    org_id: orgId,
  }
  const { data, error } = await supabase
    .from("utility_requests")
    .insert(row)
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  return data.id
}

/** Storage client: prefer service-role (avoids any server-context storage RLS
 * surprises); the action is already gated by requireStaff(). Falls back to the
 * caller's session client when the service key isn't configured. */
async function storageClient() {
  return createSupabaseAdminClient() ?? (await createSupabaseServerClient())
}

/** Fill the provider's form set from a request's saved answers. */
function fillFormsFor(
  provider: UtilityProvider,
  formData: unknown,
  cfg: UtilityOrgConfig
): Promise<FilledPdf[]> {
  if (provider === "lumber_one") {
    const form = LumberForm.safeParse(formData)
    if (!form.success) throw new Error(firstIssue(form.error))
    return fillLumberOneForms(toLumberRenderData(form.data, cfg))
  }
  const form = CawForm.safeParse(formData)
  if (!form.success) throw new Error(firstIssue(form.error))
  return fillCawForms(toRenderData(form.data, cfg))
}

/**
 * The acting staffer's org utility config, or a typed refusal when the org
 * doesn't have the Utilities module (no settings.utilities block).
 */
async function requireUtilityConfig(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>
): Promise<UtilityOrgConfig> {
  const cfg = await getUtilityConfig(
    supabase,
    await getActiveOrgId(supabase).catch(() => null)
  )
  if (!cfg) {
    throw new Error("Utilities aren't configured for your organization.")
  }
  return cfg
}

/** Storage subdirectory per provider (under {root}/utilities/). */
const STORAGE_DIR: Record<UtilityProvider, string> = {
  central_arkansas_water: "caw",
  lumber_one: "lumber-one",
}

/**
 * Generate (or regenerate) the filled PDFs for a draft request, store them
 * in the project-files bucket, and return signed preview URLs. Idempotent —
 * regenerating replaces the previous file set.
 */
export async function generateUtilityPdfs({
  requestId,
}: {
  requestId: string
}): Promise<{ files: { key: string; filename: string; path: string; url: string }[] }> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select(
      "id, project_id, crm_project_id, provider, status, form_data, generated_file_paths, updated_at"
    )
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) throw new Error("Request not found or not visible.")
  // Only drafts may (re)generate — never replace the official attachments of a
  // request that has already been submitted/paid.
  if (req.status !== "draft") {
    throw new Error("Only draft requests can generate PDFs.")
  }
  const cfg = await requireUtilityConfig(supabase)

  const filled = await fillFormsFor(req.provider, req.form_data, cfg)

  const store = await storageClient()
  const priorPaths = req.generated_file_paths ?? []

  // CRM-only jobs have no local project row, so their PDFs live under a
  // crm-jobs/ prefix instead (the staff storage policy is bucket-wide).
  const root = req.project_id
    ? `projects/${req.project_id}`
    : `crm-jobs/${req.crm_project_id}`
  const ts = Date.now()
  const out: { key: string; filename: string; path: string; url: string }[] = []
  const paths: string[] = []
  for (const f of filled) {
    const path = `${root}/utilities/${STORAGE_DIR[req.provider]}/${ts}-${f.key}.pdf`
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
      if (rmErr) console.warn("[generateUtilityPdfs] could not remove old PDFs:", rmErr.message)
    }
  }

  const urls = await getUtilitySignedUrls(paths)
  for (const o of out) o.url = urls[o.path] ?? ""

  revalidatePath("/utilities")
  return { files: out }
}

/** Per-provider recipient, subject, and body for a submission email. */
function providerEmail(
  provider: UtilityProvider,
  formData: unknown,
  cfg: UtilityOrgConfig
): { to: string; subject: string; lines: string[] } {
  if (provider === "lumber_one") {
    const form = LumberForm.safeParse(formData)
    if (!form.success) throw new Error(firstIssue(form.error))
    const addr = form.data.streetAddress
    return {
      to: cfg.lumberOne.submissionEmail,
      subject: `New Job Set-Up Request - ${addr}`,
      lines: [
        `Please find attached the New Job Set-Up Request form for a new ${cfg.builder.companyName} job.`,
        "",
        `Job address: ${addr}${form.data.city ? `, ${form.data.city}` : ""}${form.data.zip ? ` ${form.data.zip}` : ""}`,
        `Customer: ${cfg.builder.companyName}`,
        "",
        "Salesperson initials/number, account number, and estimated sales are left blank on the form - please fill those in on your end.",
        "",
        "Thank you,",
        cfg.builder.companyName,
      ],
    }
  }
  const form = CawForm.safeParse(formData)
  if (!form.success) throw new Error(firstIssue(form.error))
  const addr = form.data.serviceAddress
  // Spread-conditionals rather than filter(l => l !== "") — filtering would
  // also strip the deliberate blank-line separators between paragraphs.
  return {
    to: cfg.caw.submissionEmail,
    subject: `New Water Service Request - ${addr}`,
    lines: [
      "Please find attached the New Service application for a new construction water service request.",
      "",
      `Service address: ${addr}${form.data.city ? `, ${form.data.city}` : ""}${form.data.zip ? ` ${form.data.zip}` : ""}`,
      `Applicant: ${cfg.builder.companyName}`,
      ...(form.data.includeStandpipe
        ? ["A temporary construction standpipe is requested (see attached agreement)."]
        : []),
      "",
      "Attached:",
      "  - Request For Water Service Application",
      "  - Water Service Contract",
      ...(form.data.includeStandpipe
        ? ["  - Agreement for Temporary Construction Standpipe"]
        : []),
      "",
      "Thank you,",
      cfg.builder.companyName,
    ],
  }
}

/** Whether the provider's org details are complete enough to send. */
function providerConfiguredReason(
  provider: UtilityProvider,
  cfg: UtilityOrgConfig
): string | null {
  if (provider === "lumber_one") {
    return isLumberOneConfigured(cfg)
      ? null
      : "Lumber One details aren't configured yet. Fill them in before sending."
  }
  return isCawConfigured(cfg)
    ? null
    : "CAW builder details aren't configured yet (company name, phone, email, mailing address). Fill them in before sending."
}

/** Email a request's generated forms to its provider's intake. */
export async function sendUtilityForms({
  requestId,
}: {
  requestId: string
}): Promise<{ sent: boolean; reason?: string }> {
  const sender = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: req, error } = await supabase
    .from("utility_requests")
    .select("id, project_id, provider, status, form_data, generated_file_paths")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) throw new Error("Request not found or not visible.")
  // Typed refusals, not throws — production redacts thrown action messages.
  let cfg: UtilityOrgConfig | null
  try {
    cfg = await getUtilityConfig(
      supabase,
      await getActiveOrgId(supabase).catch(() => null)
    )
  } catch (e) {
    return {
      sent: false,
      reason: e instanceof Error ? e.message : "Could not load utility settings.",
    }
  }
  if (!cfg) {
    return {
      sent: false,
      reason: "Utilities aren't configured for your organization.",
    }
  }
  const notConfigured = providerConfiguredReason(req.provider, cfg)
  if (notConfigured) {
    return { sent: false, reason: notConfigured }
  }
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
    // Recipient + wording depend on the provider; validates form_data too.
    const email = providerEmail(req.provider, claimed.form_data, cfg)

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
        filename: attachmentName(path),
        content: buf.toString("base64"),
      })
    }
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw new Error("Generated forms are too large to email. Contact support.")
    }

    const { sendEmail } = await import("@/lib/email")
    result = await sendEmail({
      to: email.to,
      // CC the staff member who sent it so they get a copy as confirmation.
      cc: sender.email ?? undefined,
      // Reply-To so the provider's response (and any reply on the thread)
      // reaches a real mailbox instead of the send-only Resend From address.
      // Prefer the sender; fall back to the builder inbox if their profile
      // somehow has no email, so the header is never the undeliverable From.
      replyTo: sender.email ?? cfg.builder.email,
      subject: email.subject,
      text: email.lines.join("\n"),
      attachments,
      log: {
        project_id: req.project_id,
        sent_by: sender.id,
        kind: "utility_forms",
        counterparty_name: req.provider,
      },
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
 * Walk a submitted request through its post-submission steps. CAW goes through
 * the external pay-by-link flow (submitted → awaiting_payment → paid →
 * complete); Lumber One has none — sending the form is terminal, no
 * confirmation step.
 * Returns a typed result (not a throw) for the user-facing guards, because
 * Next.js redacts thrown server-action error messages in production — so the
 * operator would otherwise see a generic "Update failed." instead of the real
 * reason.
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
    .select("id, provider, status")
    .eq("id", requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!req) return { ok: false, error: "Request not found or not visible." }

  // Guard the workflow: each step only advances from the prior state.
  const allowed: Record<string, string | undefined> =
    req.provider === "lumber_one"
      ? {}
      : { awaiting_payment: "submitted", paid: "awaiting_payment", complete: "paid" }
  if (req.status !== allowed[status]) {
    return { ok: false, error: `Cannot move from "${req.status}" to "${status}".` }
  }

  const patch: TablesUpdate<"utility_requests"> = { status }
  if (status === "awaiting_payment") {
    // Typed errors, not throws — production redacts thrown action messages.
    let cfg: UtilityOrgConfig | null
    try {
      cfg = await getUtilityConfig(
        supabase,
        await getActiveOrgId(supabase).catch(() => null)
      )
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Could not load utility settings.",
      }
    }
    if (!cfg) {
      return {
        ok: false,
        error: "Utilities aren't configured for your organization.",
      }
    }
    patch.payment_url = cfg.caw.paymentUrl
  }
  if (status === "paid") patch.paid_at = new Date().toISOString()

  // Bind to the expected prior state so a concurrent transition can't double-apply.
  const { data: updated, error: updErr } = await supabase
    .from("utility_requests")
    .update(patch)
    .eq("id", requestId)
    .eq("status", req.status)
    .select("id")
    .maybeSingle()
  if (updErr) throw new Error(updErr.message)
  if (!updated) {
    return { ok: false, error: "This request just changed — refresh and try again." }
  }
  revalidatePath("/utilities")
  return { ok: true }
}

/**
 * Delete a utility request (any status) along with its generated PDFs.
 * Returns a typed result — Next.js redacts thrown server-action error
 * messages in production, and "not found" should reach the user verbatim.
 */
export async function deleteUtilityRequest({
  requestId,
}: {
  requestId: string
}): Promise<{ ok: boolean; error?: string }> {
  await requireStaff()
  const id = z.string().min(1).parse(requestId)
  const supabase = await createSupabaseServerClient()

  // Capture the generated file paths before the row disappears.
  const { data: req } = await supabase
    .from("utility_requests")
    .select("id, generated_file_paths")
    .eq("id", id)
    .maybeSingle()
  if (!req) return { ok: false, error: "Request not found or not visible." }

  const { error } = await supabase.from("utility_requests").delete().eq("id", id)
  if (error) return { ok: false, error: error.message }

  // Best-effort cleanup of the orphaned PDF objects — done after the row is
  // gone so a storage hiccup never blocks the delete.
  if (req.generated_file_paths?.length) {
    const store = await storageClient()
    const { error: rmErr } = await store.storage
      .from(BUCKET)
      .remove(req.generated_file_paths)
    if (rmErr) {
      console.warn("[deleteUtilityRequest] could not remove PDFs:", rmErr.message)
    }
  }

  revalidatePath("/utilities")
  return { ok: true }
}

export type UtilityPrefill = {
  serviceAddress?: string
  city?: string
  zip?: string
  subdivision?: string
  block?: string
  lot?: string
  squareFootage?: string
  multiStory?: boolean
  floors?: string
  // Lumber One extras
  county?: string
  jobName?: string
  propertyOwner?: string
  deliveryDirections?: string
  /** "crm" when matched in the CRM, "none" when it fell back to the local data. */
  source: "crm" | "none"
}

// Raw shape we read from the CRM projects_dashboard_full view (untyped client,
// so we narrow it ourselves).
type CrmPrefillRow = {
  street_address: string | null
  city: string | null
  lot_block: string | null
  subdivision_name: string | null
  total_area_without_veneer: number | null
  total_area_with_veneer: number | null
  floors: number | null
  land_price?: number | string | null
  client_name?: string | null
  zip?: string | number | null
  zip_code?: string | number | null
  postal_code?: string | number | null
  zipcode?: string | number | null
}

/**
 * Who owns the property, for Lumber One's "Property Owner" line. Per Brandon:
 * a positive land price on the CRM job means Hines Homes bought the lot (spec
 * or build-to-sell) — the owner is Hines Homes. Otherwise the client already
 * owns the lot, so their name goes on the form. Placeholder client names
 * ("Spec", blank) yield undefined and leave the field for the user.
 */
function resolvePropertyOwner(
  row: CrmPrefillRow,
  cfg: UtilityOrgConfig
): string | undefined {
  const landPrice = Number(row.land_price ?? 0)
  if (Number.isFinite(landPrice) && landPrice > 0) return cfg.builder.companyName
  const client = (row.client_name ?? "").trim()
  if (!client || client.toLowerCase() === "spec") return undefined
  return client
}

/** Map a CRM dashboard row to the utility prefill fields. */
function prefillFromCrmRow(
  row: CrmPrefillRow,
  cfg: UtilityOrgConfig,
  fallbackAddress?: string
): UtilityPrefill {
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
    resolveCawZip(cfg, { subdivision: row.subdivision_name, city: row.city })
  const serviceAddress = row.street_address ?? fallbackAddress ?? undefined
  return {
    serviceAddress,
    city: row.city ?? undefined,
    zip,
    subdivision: row.subdivision_name ?? undefined,
    block: block || undefined,
    lot: lot || undefined,
    squareFootage: sqft != null ? String(Math.round(sqft)) : undefined,
    multiStory: floors != null ? floors > 1 : undefined,
    floors: floors != null && floors > 1 ? String(floors) : undefined,
    // Lumber One extras. Job Name is the street address by convention.
    county: resolveCounty(cfg, row.city),
    jobName: serviceAddress,
    propertyOwner: resolvePropertyOwner(row, cfg),
    deliveryDirections:
      defaultDeliveryDirections(cfg, row.subdivision_name) || undefined,
    source: "crm",
  }
}

/**
 * Pull extra property details from the Hines Homes CRM to pre-fill the
 * provider forms: city, ZIP, subdivision, lot/block, square footage, floor
 * count, plus the Lumber One county / job name / property owner / delivery
 * note. Jobs picked from the CRM-sourced dropdown pass crmId (direct lookup);
 * local-only projects pass projectId (matched by project_number). Best-effort
 * — returns source:"none" (with just the local address, if any) when the CRM
 * isn't configured or has no matching row.
 */
export async function getUtilityPrefill({
  projectId,
  crmId,
}: {
  projectId?: string | null
  crmId?: string | null
}): Promise<UtilityPrefill> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const cfg = await requireUtilityConfig(supabase)
  // CRM prefill reads Hines Homes' external CRM — legacy org only. A
  // non-legacy org falls through to the local-project branch.
  const crm = (await isLegacyActiveOrg(supabase, me.id))
    ? createCrmClient()
    : null

  if (crmId) {
    if (!crm) return { source: "none" }
    // select("*") so we pick up a ZIP column whatever it's named in the view
    // (zip / zip_code / postal_code), and so a not-yet-added column never
    // errors the query — it just comes back undefined.
    const { data, error } = await crm
      .from("projects_dashboard_full")
      .select("*")
      .eq("id", crmId)
      .maybeSingle()
    if (error || !data) return { source: "none" }
    return prefillFromCrmRow(data as CrmPrefillRow, cfg)
  }

  if (!projectId) return { source: "none" }
  const { data: project } = await supabase
    .from("projects")
    .select("project_number, address")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return { source: "none" }

  const fallback: UtilityPrefill = {
    serviceAddress: project.address ?? undefined,
    jobName: project.address ?? undefined,
    source: "none",
  }
  if (!crm || !project.project_number) return fallback

  const { data, error } = await crm
    .from("projects_dashboard_full")
    .select("*")
    .eq("project_number", project.project_number)
    .maybeSingle()
  if (error || !data) return fallback

  return prefillFromCrmRow(data as CrmPrefillRow, cfg, project.address ?? undefined)
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
