"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getCrmProjectStatus } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import { addDays } from "@/lib/utils"
import {
  dashboardProjectUrl,
  dashboardUrlForProject,
  getDashboardProject,
  sendDashboardWebhook,
} from "@/lib/dashboard"
import type { Tables, TablesUpdate } from "@/lib/db/types"
import {
  collectBaseTags,
  matchesTemplateTags,
  type TemplateAttributes,
} from "@/lib/template-tags"
import { ensureProjectMilestones } from "./schedule"

const ProjectInput = z.object({
  project_number: z.string().min(1, "Required").max(64),
  name: z.string().min(1, "Required").max(200),
  address: z.string().max(500).optional().or(z.literal("")),
  status: z
    .enum([
      "upcoming",
      "in_work",
      "complete",
      "warranty",
      "inventory",
      "paused",
      "cancelled",
    ])
    .default("in_work"),
  // Drives client-facing branding (residential → Hines Homes, commercial →
  // MJV Building Group). Optional; empty string maps to "unset".
  project_type: z
    .enum([
      "residential_new",
      "residential_remodel",
      "commercial_new",
      "commercial_remodel",
    ])
    .optional()
    .or(z.literal("").transform(() => undefined)),
  contract_price: z.coerce.number().nonnegative().nullable().optional(),
  start_date: z.string().optional().or(z.literal("")),
  // Staff CAN paste a custom URL but the default is auto-derived from
  // project_number — see dashboardProjectUrl().
  dashboard_url: z
    .string()
    .trim()
    .optional()
    .or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  // Client identity. Source of truth is the dashboard when this project was
  // pulled from there; for blank-created projects staff can still type them.
  // Validation: email must look like an email, phone must contain only the
  // characters phone numbers actually use. Empty strings pass through (the
  // field is optional). Stricter than necessary keeps mailto:/tel: links
  // safe to render in the project header.
  client_name: z.string().max(200).optional().or(z.literal("")),
  client_email: z
    .string()
    .max(200)
    .email("Must be a valid email")
    .optional()
    .or(z.literal("")),
  client_phone: z
    .string()
    .max(50)
    .regex(/^[+\d\s().\-x]*$/, "Phone may only contain digits, spaces, +, -, (), ., or x")
    .optional()
    .or(z.literal("")),
  // "1" if this came from the dashboard picker. Used to set dashboard_pulled_at
  // server-side so we don't trust a client-supplied timestamp.
  dashboard_pulled: z.string().optional().or(z.literal("")),
  // If present, the new project is created by duplicating this source
  // project (template) and then layering the form's identity fields on top.
  source_template_id: z.string().optional().or(z.literal("")),
  // JSON-serialized smart-template answers (TemplateOptions component):
  // house-attribute booleans + per-selection include/allowance overrides.
  // Only meaningful alongside source_template_id.
  attributes_json: z.string().optional().or(z.literal("")),
  selection_overrides_json: z.string().optional().or(z.literal("")),
})

// House-attribute answers: { walkout: true, finished_basement: false }.
const AttributesSchema = z.record(z.string(), z.boolean())

// Per-selection review answers from the duplicate flow. `include: false`
// drops the selection entirely; `allowance_amount` replaces the template's
// placeholder allowance with the contract's real number (null clears it).
const SelectionOverride = z.object({
  decision_id: z.string(),
  include: z.boolean(),
  allowance_amount: z.number().nullable().optional(),
})
export type SelectionOverrideT = z.infer<typeof SelectionOverride>

export type ProjectFormState = {
  error?: string
  fieldErrors?: Record<string, string>
}

function emptyToNull<T extends string | undefined | null>(v: T) {
  return v === "" || v == null ? null : v
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export async function createProject(
  _prev: ProjectFormState | undefined,
  formData: FormData
): Promise<ProjectFormState> {
  const profile = await requireStaff()
  const parsed = ProjectInput.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = issue.path[0]?.toString() ?? "_"
      fieldErrors[k] = issue.message
    }
    return { fieldErrors, error: "Please fix the highlighted fields" }
  }
  const input = parsed.data

  // Server-side verify the "this came from the dashboard" claim. The form
  // sends dashboard_pulled=1 when staff used the picker, but we can't trust
  // that flag — a crafted request could set it for any project_number. So
  // we re-fetch the project from the dashboard and only stamp
  // dashboard_pulled_at when the dashboard actually has this project.
  // If the dashboard is unreachable / not configured / the project is no
  // longer there, we silently leave the timestamp NULL (the row still saves
  // — staff get their project, it just looks like a blank-created one).
  // We also reuse this fetch for the canonical link + project manager.
  let remote: Awaited<ReturnType<typeof getDashboardProject>> = null
  let dashboardPulledAt: string | null = null
  if (input.dashboard_pulled === "1") {
    remote = await getDashboardProject(input.project_number)
    if (remote) dashboardPulledAt = new Date().toISOString()
  }

  // Link priority: a URL staff explicitly pasted, then the dashboard's own
  // link (built from its INTERNAL id so it actually resolves — linking by
  // project_number 500s the dashboard's uuid-keyed route), then the
  // project_number fallback for blank-created projects.
  const finalDashboardUrl =
    emptyToNull(input.dashboard_url) ??
    (remote
      ? dashboardUrlForProject(remote)
      : dashboardProjectUrl(input.project_number))

  // Project manager is dashboard-owned; null for blank-created projects.
  const projectManager = remote?.project_manager ?? null
  // Second client (the form only captures the first); dashboard-owned.
  const clientName2 = remote?.client_name_2 ?? null
  const clientEmail2 = remote?.client_email_2 ?? null
  const clientPhone2 = remote?.client_phone_2 ?? null

  // Combo path: copy a template's schedule + decisions, but use the form's
  // identity fields (typically pulled from the dashboard) for the new
  // project shell. duplicateProject does the heavy lifting; we just hand it
  // the overrides. We resolve the new id outside the try/catch so the
  // redirect() throw isn't swallowed (Next 16 redirect throws a special
  // NEXT_REDIRECT error that has to propagate).
  if (input.source_template_id) {
    // Parse the smart-template answers the TemplateOptions component
    // serialized into hidden fields. Malformed JSON is a hard error — a
    // silent fallback would copy waterproofing items into a slab house.
    let templateAttributes: TemplateAttributes | undefined
    let selectionOverrides: SelectionOverrideT[] | undefined
    if (input.attributes_json) {
      const attrsParsed = AttributesSchema.safeParse(
        safeJsonParse(input.attributes_json)
      )
      if (!attrsParsed.success) {
        return { error: "Template answers were malformed — please retry." }
      }
      templateAttributes = attrsParsed.data
    }
    if (input.selection_overrides_json) {
      const ovrParsed = z
        .array(SelectionOverride)
        .safeParse(safeJsonParse(input.selection_overrides_json))
      if (!ovrParsed.success) {
        return { error: "Selection answers were malformed — please retry." }
      }
      selectionOverrides = ovrParsed.data
    }
    let templateResult: Awaited<ReturnType<typeof duplicateProject>> | null = null
    try {
      templateResult = await duplicateProject({
        source_project_id: input.source_template_id,
        attributes: templateAttributes,
        selection_overrides: selectionOverrides,
        new_project_number: input.project_number,
        new_name: input.name,
        new_start_date: emptyToNull(input.start_date),
        override_address: emptyToNull(input.address),
        override_status: input.status,
        override_project_type: input.project_type,
        override_contract_price: input.contract_price ?? null,
        override_dashboard_url: finalDashboardUrl,
        override_project_manager: projectManager,
        override_notes: emptyToNull(input.notes),
        override_client_name: emptyToNull(input.client_name),
        override_client_email: emptyToNull(input.client_email),
        override_client_phone: emptyToNull(input.client_phone),
        override_client_name_2: clientName2,
        override_client_email_2: clientEmail2,
        override_client_phone_2: clientPhone2,
        override_dashboard_pulled_at: dashboardPulledAt,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to copy from template"
      if (/already exists/i.test(msg) || /23505/.test(msg)) {
        return { fieldErrors: { project_number: msg }, error: msg }
      }
      return { error: msg }
    }
    revalidatePath("/projects")
    redirect(`/projects/${templateResult.id}/schedule`)
  }

  // Mirror the CRM's status from birth. Without this a new job takes the
  // form's default ("In Work") and only corrects to the dashboard's status on
  // the next "Sync from CRM". Look the job up by project_number and, when the
  // CRM has it, adopt its status and store the verbatim word (what the badge
  // shows). Falls back to the form value when the CRM isn't configured or has
  // no matching row. Same mapping as syncProjectsFromCrm.
  const crmStatus = await getCrmProjectStatus(input.project_number)
  const crmSyncedAt = crmStatus ? new Date().toISOString() : null

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("projects")
    .insert({
      project_number: input.project_number,
      name: input.name,
      address: emptyToNull(input.address),
      status: crmStatus?.mapped ?? input.status,
      crm_status: crmStatus?.crmStatus ?? null,
      crm_status_synced_at: crmSyncedAt,
      project_type: input.project_type ?? null,
      contract_price: input.contract_price ?? null,
      start_date: emptyToNull(input.start_date) ?? null,
      dashboard_url: finalDashboardUrl,
      project_manager: projectManager,
      notes: emptyToNull(input.notes),
      client_name: emptyToNull(input.client_name),
      client_email: emptyToNull(input.client_email),
      client_phone: emptyToNull(input.client_phone),
      client_name_2: clientName2,
      client_email_2: clientEmail2,
      client_phone_2: clientPhone2,
      // Set server-side after re-fetching the dashboard to confirm the
      // pull. See the dashboardPulledAt computation above.
      dashboard_pulled_at: dashboardPulledAt,
      created_by: profile.id,
    })
    .select("*")
    .single()

  if (error) {
    return {
      error:
        error.code === "23505"
          ? `Project number "${input.project_number}" already exists`
          : error.message,
    }
  }

  // Every project carries its two protected milestones from birth. Non-fatal:
  // the schedule health banner offers a create fallback if this ever fails.
  try {
    await ensureProjectMilestones({ project_id: data.id })
    // Anchor the Job Start milestone to the project's start date (the CRM's
    // Projected Start Date) so a blank job behaves like a template-built one,
    // where the copy path lands Job Start on this date. No baseline exists on
    // a brand-new project, so this write needs no move reason.
    const startDate = emptyToNull(input.start_date)
    if (startDate) {
      await supabase
        .from("schedule_items")
        .update({ start_date: startDate, end_date: startDate })
        .eq("project_id", data.id)
        .eq("milestone", "job_start")
    }
  } catch (e) {
    console.warn(
      "[createProject] milestone creation failed:",
      e instanceof Error ? e.message : e
    )
  }

  // Best-effort: tell the dashboard a new project exists. Webhook failures
  // never block the redirect — the dashboard can backfill from /projects/[id].
  await sendDashboardWebhook("project.created", data)

  revalidatePath("/projects")
  redirect(`/projects/${data.id}/schedule`)
}

// ---------------------------------------------------------------------------
// Re-pull dashboard-owned fields for an existing project
// ---------------------------------------------------------------------------

export type SyncDashboardResult =
  | { ok: true; project_manager: string | null }
  | { ok: false; error: string }

/**
 * Re-fetches this project from the dashboard (by project_number) and refreshes
 * the dashboard-owned fields PM mirrors: the canonical dashboard link (built
 * from the dashboard's internal id so it actually opens the job) and the
 * project manager. Used by the per-project "Sync from dashboard" button to fix
 * projects created before this data was captured.
 *
 * Returns a typed result rather than throwing on user-facing failures —
 * Next.js masks thrown messages in production, so a missing-config / not-found
 * case would otherwise surface as a generic error toast.
 */
export async function syncProjectFromDashboard(input: {
  project_id: string
}): Promise<SyncDashboardResult> {
  await requireStaff()
  const parsed = z.object({ project_id: z.string() }).safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid project." }
  const supabase = await createSupabaseServerClient()

  const { data: project, error } = await supabase
    .from("projects")
    .select("id, project_number")
    .eq("id", parsed.data.project_id)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!project) return { ok: false, error: "Project not found." }

  const remote = await getDashboardProject(project.project_number)
  if (!remote) {
    return {
      ok: false,
      error:
        "Couldn't reach the dashboard, or this job isn't on it yet. Check the dashboard, then try again.",
    }
  }

  // Only overwrite fields the dashboard actually gave us. The dashboard's
  // /api/projects endpoint currently doesn't return the internal id or the
  // project manager, so without these guards a Sync would clobber a
  // correct stored link (built from the id) with the project_number route
  // that 500s, and wipe a known PM back to null. Build the update set
  // conditionally instead.
  const update: {
    dashboard_pulled_at: string
    dashboard_url?: string | null
    project_manager?: string | null
    client_name?: string | null
    client_email?: string | null
    client_phone?: string | null
    client_name_2?: string | null
    client_email_2?: string | null
    client_phone_2?: string | null
  } = { dashboard_pulled_at: new Date().toISOString() }
  // Only persist a link that actually resolves the job. dashboardUrlForProject
  // returns the project_number route (which 500s) when there's no id and no
  // ABSOLUTE url, and null when the dashboard base is unconfigured — neither
  // should clobber a good stored link. Gate on the computed value, requiring
  // an id or a genuinely absolute url first.
  const candidateUrl =
    remote.id || (remote.url && /^https?:\/\//i.test(remote.url))
      ? dashboardUrlForProject(remote)
      : null
  if (candidateUrl) {
    update.dashboard_url = candidateUrl
  }
  if (remote.project_manager) {
    update.project_manager = remote.project_manager
  }
  // Client identity (both slots). Only overwrite when the dashboard returns a
  // non-empty value — its API leaves these blank today, and we don't want to
  // wipe values backfilled straight from the dashboard's clients table.
  const nzTrim = (v: string | null | undefined) => {
    const trimmed = v?.trim()
    return trimmed ? trimmed : undefined
  }
  const clientFields = {
    client_name: nzTrim(remote.client_name),
    client_email: nzTrim(remote.client_email),
    client_phone: nzTrim(remote.client_phone),
    client_name_2: nzTrim(remote.client_name_2),
    client_email_2: nzTrim(remote.client_email_2),
    client_phone_2: nzTrim(remote.client_phone_2),
  }
  for (const [k, v] of Object.entries(clientFields)) {
    if (v !== undefined) (update as Record<string, unknown>)[k] = v
  }

  // Nothing useful came back beyond the timestamp — tell the user rather than
  // silently "succeeding" with no visible change.
  const meaningful = Object.keys(update).filter(
    (k) => k !== "dashboard_pulled_at"
  )
  if (meaningful.length === 0) {
    return {
      ok: false,
      error:
        "The dashboard didn't return a project manager, client info, or a job link for this project. (The dashboard's API needs to expose those fields.)",
    }
  }

  const { error: uErr } = await supabase
    .from("projects")
    .update(update)
    .eq("id", project.id)
  if (uErr) return { ok: false, error: uErr.message }

  revalidatePath(`/projects/${project.id}`)
  revalidatePath("/projects")
  return { ok: true, project_manager: remote.project_manager }
}

// ---------------------------------------------------------------------------
// Edit existing project (header dialog — covers everything but project_number)
// ---------------------------------------------------------------------------

// Optional-ish field helpers. Most fields can be blanked (""), and we map
// those to null below so the DB ends up with a real NULL, not an empty
// string. project_number is intentionally not editable here — it's the
// public key, referenced by the dashboard URL and elsewhere.
const optEditStr = z
  .string()
  .max(500)
  .optional()
  .or(z.literal(""))

// Dates from <input type="date"> arrive as YYYY-MM-DD. Validate the shape
// here so a forged or stale payload errors at the action boundary instead
// of as a generic Postgres "invalid input syntax for type date" later on.
const optEditDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .optional()
  .or(z.literal(""))

const ProjectEditInput = z
  .object({
    // z.guid() validates UUID shape without the RFC variant-digit strictness
    // of z.uuid() (which incorrectly rejects some valid Postgres UUIDs in
    // this DB — see PR #22 follow-up).
    project_id: z.guid(),
    name: z.string().min(1, "Name is required").max(200),
    address: optEditStr,
    status: z.enum([
      "upcoming",
      "in_work",
      "complete",
      "warranty",
      "inventory",
      "paused",
      "cancelled",
    ]),
    contract_price: z.coerce
      .number()
      .nonnegative()
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    start_date: optEditDate,
    client_name: z.string().max(200).optional().or(z.literal("")),
    client_email: z
      .string()
      .max(200)
      .email("Must be a valid email")
      .optional()
      .or(z.literal("")),
    client_phone: z
      .string()
      .max(50)
      .regex(/^[+\d\s().\-x]*$/, "Phone may only contain digits, spaces, +, -, (), ., or x")
      .optional()
      .or(z.literal("")),
    client_name_2: z.string().max(200).optional().or(z.literal("")),
    client_email_2: z
      .string()
      .max(200)
      .email("Must be a valid email")
      .optional()
      .or(z.literal("")),
    client_phone_2: z
      .string()
      .max(50)
      .regex(/^[+\d\s().\-x]*$/, "Phone may only contain digits, spaces, +, -, (), ., or x")
      .optional()
      .or(z.literal("")),
    // Cost-plus jobs bill actual cost, so they track labor hours on daily
    // logs. Optional so a partial-update caller can't silently flip an
    // existing cost-plus project back to fixed-price by omitting it.
    cost_plus: z.boolean().optional(),
    // Marks this project as a reusable template — the only kind offered as a
    // source in "New project → Start from template". Optional for the same
    // reason as cost_plus: omitting it must not clear an existing flag.
    is_template: z.boolean().optional(),
    // Branding driver. Empty string clears it back to "unset" (Hines default).
    project_type: z
      .enum([
        "residential_new",
        "residential_remodel",
        "commercial_new",
        "commercial_remodel",
      ])
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    notes: z.string().optional().or(z.literal("")),
  })

export type UpdateProjectResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

export async function updateProject(
  input: z.input<typeof ProjectEditInput>
): Promise<UpdateProjectResult> {
  await requireStaff()
  const parsed = ProjectEditInput.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "_"
      if (!fieldErrors[key]) fieldErrors[key] = issue.message
    }
    return {
      ok: false,
      error: "Please fix the highlighted fields",
      fieldErrors,
    }
  }
  const { project_id, ...rest } = parsed.data
  const supabase = await createSupabaseServerClient()
  // Branding and cost-plus are only written when the caller explicitly sends
  // them, so a partial-update caller can't accidentally clear an existing
  // value by omission. The edit dialog always sends both.
  const update: TablesUpdate<"projects"> = {
    name: rest.name,
    address: emptyToNull(rest.address),
    status: rest.status,
    contract_price: rest.contract_price ?? null,
    start_date: emptyToNull(rest.start_date) ?? null,
    client_name: emptyToNull(rest.client_name),
    client_email: emptyToNull(rest.client_email),
    client_phone: emptyToNull(rest.client_phone),
    client_name_2: emptyToNull(rest.client_name_2),
    client_email_2: emptyToNull(rest.client_email_2),
    client_phone_2: emptyToNull(rest.client_phone_2),
    notes: emptyToNull(rest.notes),
  }
  if (rest.cost_plus !== undefined) update.cost_plus = rest.cost_plus
  if (rest.is_template !== undefined) update.is_template = rest.is_template
  if (rest.project_type !== undefined) update.project_type = rest.project_type
  // .select() forces the update to return the matched row so we can tell a
  // silent zero-rows case (wrong id, or RLS hid it) apart from a real save.
  const { data, error } = await supabase
    .from("projects")
    .update(update)
    .eq("id", project_id)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Project not found." }
  revalidatePath(`/projects/${project_id}`)
  revalidatePath(`/projects/${project_id}/onsite`)
  revalidatePath(`/projects/${project_id}/schedule`)
  revalidatePath(`/projects/${project_id}/pricing`)
  revalidatePath(`/projects/${project_id}/daily-logs`)
  revalidatePath("/projects")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Delete project (header edit dialog — danger zone)
// ---------------------------------------------------------------------------

const DeleteProjectInput = z.object({
  // Same UUID-shape validation as the edit action (z.guid, not z.uuid — see
  // ProjectEditInput for why).
  project_id: z.guid(),
})

export type DeleteProjectResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Permanently delete a project and everything hanging off it. Every
 * per-project table FKs `projects(id) ON DELETE CASCADE` (schedule items +
 * checklists + predecessors + assignments, decisions + choices/cost items/
 * followups/attachments, daily logs, files, payments, bids, POs, members,
 * roles, portal invites), so a single row delete cascades the whole job.
 * `communications` FKs `ON DELETE SET NULL`, so channel history survives
 * un-filed. `project_history` is a bare uuid (no FK), so its rows are simply
 * orphaned (unreachable from the UI). The protected milestone rows delete
 * cleanly here: `protect_schedule_milestones` only blocks a milestone delete
 * while its project still exists, and during this cascade the project row is
 * already gone (see migration 0069).
 *
 * Runs under the caller's session, so RLS (`projects_staff_all`) gates it to
 * staff. We do NOT notify the dashboard/CRM — that's the source of truth for
 * jobs, and this only removes the PM-side mirror.
 *
 * Note: Storage objects (files, decision/daily-log attachments) are NOT
 * removed — the private-bucket blobs are left orphaned, matching the v1
 * policy for unreferenced objects elsewhere in the app.
 */
export async function deleteProject(
  input: z.input<typeof DeleteProjectInput>
): Promise<DeleteProjectResult> {
  await requireStaff()
  const parsed = DeleteProjectInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid project." }
  const supabase = await createSupabaseServerClient()

  // .select() forces the delete to return the matched row so we can tell a
  // silent zero-rows case (wrong id, or RLS hid it) apart from a real delete.
  const { data, error } = await supabase
    .from("projects")
    .delete()
    .eq("id", parsed.data.project_id)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) {
    return {
      ok: false,
      error: "Project not found, or you don't have permission to delete it.",
    }
  }

  revalidatePath("/projects")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const SetProjectLabelInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  label: z.string().trim().min(1).max(40),
  // true = add the label to each project, false = remove it.
  value: z.boolean(),
})

/**
 * Adds or removes a single label across one or more projects. Drives the
 * project-list sidebar's multi-select "Tag as Test" / "Remove Test" actions,
 * but is generic over the label name. Idempotent per project: adding a label a
 * project already has (or removing one it lacks) is skipped, so re-running is
 * safe. Runs under the caller's session, so RLS still gates which rows change.
 */
export async function setProjectLabel(
  input: z.input<typeof SetProjectLabelInput>
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  await requireStaff()
  const parsed = SetProjectLabelInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid label request." }

  const { ids, label, value } = parsed.data
  const supabase = await createSupabaseServerClient()
  // Apply the add/remove in one atomic statement (array_append / array_remove
  // inside a single UPDATE) via the set_project_label RPC. This avoids the
  // read-modify-write race of fetching + rewriting each row's array, and a
  // large selection becomes one round trip instead of one write per project.
  // RLS still gates which rows actually change; the RPC returns the count of
  // rows whose labels were modified (skips no-ops, never duplicates a label).
  const { data, error } = await supabase.rpc("set_project_label", {
    p_ids: ids,
    p_label: label,
    p_add: value,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/projects")
  return { ok: true, updated: data ?? 0 }
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

const DuplicateProjectInput = z
  .object({
    source_project_id: z.string(),
    new_project_number: z.string().min(1).max(64),
    new_name: z.string().min(1).max(200),
    // Optional: if provided, all schedule dates shift by (new - source) days.
    // If omitted, dates are copied verbatim (useful when the template was
    // authored against an explicit calendar already).
    new_start_date: z.string().nullish(),
    // Optional identity overrides — used by the New Project page's
    // "dashboard + template" combo path so the new project shell carries
    // the dashboard's identity instead of the template's placeholder
    // values. When any of these is undefined, the source project's value
    // is used (existing behavior).
    override_address: z.string().nullish(),
    override_status: z
      .enum([
        "upcoming",
        "in_work",
        "complete",
        "warranty",
        "inventory",
        "paused",
        "cancelled",
      ])
      .optional(),
    override_project_type: z
      .enum([
        "residential_new",
        "residential_remodel",
        "commercial_new",
        "commercial_remodel",
      ])
      .nullable()
      .optional(),
    override_contract_price: z.number().nullable().optional(),
    override_dashboard_url: z.string().nullish(),
    override_project_manager: z.string().nullish(),
    override_notes: z.string().nullish(),
    override_client_name: z.string().nullish(),
    override_client_email: z.string().nullish(),
    override_client_phone: z.string().nullish(),
    override_client_name_2: z.string().nullish(),
    override_client_email_2: z.string().nullish(),
    override_client_phone_2: z.string().nullish(),
    // Already-verified timestamp (set by createProject after re-fetching
    // from the dashboard). Pass-through — never trust a client-supplied one.
    override_dashboard_pulled_at: z.string().nullish(),
    // Smart-template answers. When `attributes` is present, template items
    // whose template_tags don't match are skipped (and predecessor chains
    // are spliced around skipped work items). When absent, everything copies
    // — plain duplicates of real projects keep working unchanged.
    attributes: AttributesSchema.optional(),
    // Per-selection include/allowance answers from the review step. Only
    // sensible for kind='selection' rows of the source project.
    selection_overrides: z.array(SelectionOverride).optional(),
  })
  .passthrough()

export type DuplicateProjectInputT = z.infer<typeof DuplicateProjectInput>

/**
 * Clone a project's structure (schedule items + checklists + predecessors,
 * role-based schedule assignments, plus decisions/selections with their cost
 * breakdowns, follow-up templates, and attachments) into a brand-new project.
 *
 * Skips project-specific data: direct (person/company) SCHEDULE assignments,
 * daily logs, files, payments, project_members, comments. Role-based schedule
 * assignments DO carry forward — they resolve to people through the new
 * project's role map.
 *
 * Note: this "direct vs role" rule applies to schedule_assignments only.
 * Decision follow-up TEMPLATES still copy their assignee_profile_id /
 * assignee_company_id verbatim (pre-existing behavior) — follow-up templates
 * don't support role targets yet, so clearing them would silently drop a
 * template's intended follow-up owner. Adding role support there is a separate
 * follow-up.
 *
 * Intended primary use: a "template" project staff maintain as the standard
 * Hines Homes build schedule + selections, duplicated for each new build.
 *
 * Resets on copy:
 * - schedule_items.status        → 'not_started'
 * - todo_checklist_items.is_done → false
 * - decisions.status             → 'draft'
 * - decisions.approved_at        → null
 * - decisions.approved_by_client_id → null
 * - decisions.number             → re-allocated 1..N in source order
 */
export async function duplicateProject(input: DuplicateProjectInputT) {
  const profile = await requireStaff()
  const result = DuplicateProjectInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid input at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  // Pull everything we need from the source project, including the source
  // project row itself so we can copy its address / status / contract / etc.
  // We surface read errors explicitly — silently ignoring them could let the
  // clone proceed with an incomplete source snapshot.
  const [
    { data: source, error: sourceErr },
    { data: srcItems, error: itemsErr },
    { data: srcChecklist, error: checklistErr },
    { data: srcPreds, error: predsErr },
    { data: srcDecisions, error: decisionsErr },
    { data: srcChoices, error: choicesErr },
    { data: srcCostItems, error: costItemsErr },
    { data: srcFollowups, error: followupsErr },
    { data: srcAttachments, error: attachmentsErr },
    { data: srcRoleAssignments, error: roleAssignmentsErr },
    { data: srcRoleMembers, error: roleMembersErr },
    { data: srcPos, error: posErr },
    { data: srcPoLines, error: poLinesErr },
    { data: srcPoAttachments, error: poAttachmentsErr },
    { data: srcBidPackages, error: bidPackagesErr },
    { data: srcBidLines, error: bidLinesErr },
    { data: srcBidRecipients, error: bidRecipientsErr },
    { data: srcBidAttachments, error: bidAttachmentsErr },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("*")
      .eq("id", parsed.source_project_id)
      .maybeSingle(),
    supabase
      .from("schedule_items")
      .select("*")
      .eq("project_id", parsed.source_project_id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("todo_checklist_items")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("schedule_predecessors")
      .select(
        "*, schedule_items!schedule_predecessors_item_id_fkey!inner(project_id)"
      )
      .eq("schedule_items.project_id", parsed.source_project_id),
    supabase
      .from("decisions")
      .select("*")
      .eq("project_id", parsed.source_project_id)
      .order("created_at", { ascending: true }),
    // Choices + cost items + followup templates + attachments are joined
    // through decisions so we only get rows that belong to the source
    // project, regardless of which decisions actually have any.
    supabase
      .from("decision_choices")
      // FK-hinted: decisions↔decision_choices has two relationships
      // (decision_id + selected_choice_id), so the bare embed is PGRST201-
      // ambiguous — same class of fix as the followup-templates read below.
      .select(
        "*, decisions!decision_choices_decision_id_fkey!inner(project_id)"
      )
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_cost_items")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_followup_templates")
      // Disambiguate the embed: decision_followup_templates relates to
      // decisions both directly (decision_id) AND through the
      // decision_followup_materializations junction, so PostgREST needs the
      // FK name or it errors with PGRST201 (same fix as #48, this read was
      // missed).
      .select(
        "*, decisions!decision_followup_templates_decision_id_fkey!inner(project_id)"
      )
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_attachments")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    // Role-based assignments only. A template assigns its items to roles, not
    // to specific people — those carry forward so the new job resolves them
    // through its own role map. Direct profile/company assignments stay
    // project-specific and are NOT copied (unchanged behavior).
    supabase
      .from("schedule_assignments")
      .select("schedule_item_id, role_id, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", parsed.source_project_id)
      .not("role_id", "is", null),
    // Role members: the "who fills each role" map (Project Manager, Site
    // Superintendent, and every trade role). Copied verbatim so a job built
    // from the Template inherits the same people / companies in the same
    // roles. Roles are org-wide, so only project_id changes on the copy.
    supabase
      .from("project_role_members")
      .select("role_id, profile_id, company_id")
      .eq("project_id", parsed.source_project_id),
    // Purchase orders + bid packages: the template ships its standard POs
    // and bid requests, so a job built from it starts with the same
    // purchasing paperwork as fresh drafts. Child rows join through their
    // parent so we only get the source project's rows.
    supabase
      .from("purchase_orders")
      .select("*")
      .eq("project_id", parsed.source_project_id)
      .order("number", { ascending: true }),
    supabase
      .from("po_line_items")
      .select("*, purchase_orders!inner(project_id)")
      .eq("purchase_orders.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("po_attachments")
      .select("*, purchase_orders!inner(project_id)")
      .eq("purchase_orders.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("bid_packages")
      .select("*")
      .eq("project_id", parsed.source_project_id)
      .order("number", { ascending: true }),
    supabase
      .from("bid_package_line_items")
      .select("*, bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("bid_recipients")
      .select("*, bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", parsed.source_project_id)
      .order("created_at", { ascending: true }),
    supabase
      .from("bid_package_attachments")
      .select("*, bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
  ])
  const readErr =
    sourceErr ??
    itemsErr ??
    checklistErr ??
    predsErr ??
    decisionsErr ??
    choicesErr ??
    costItemsErr ??
    followupsErr ??
    attachmentsErr ??
    roleAssignmentsErr ??
    roleMembersErr ??
    posErr ??
    poLinesErr ??
    poAttachmentsErr ??
    bidPackagesErr ??
    bidLinesErr ??
    bidRecipientsErr ??
    bidAttachmentsErr
  if (readErr) throw new Error(`Source read failed: ${readErr.message}`)
  if (!source) throw new Error("Source project not found")

  // Smart-template filter: when attribute answers were provided, drop items
  // whose template_tags don't match. Children of a skipped item are skipped
  // too (a to-do nested under skipped waterproofing work makes no sense on
  // its own), propagated until stable since parent rows can appear in any
  // order.
  type SrcItem = Tables<"schedule_items">
  const attrs = parsed.attributes
  const skippedItemIds = new Set<string>()
  if (attrs) {
    for (const it of (srcItems ?? []) as SrcItem[]) {
      if (!matchesTemplateTags(it.template_tags, attrs)) {
        skippedItemIds.add(it.id)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const it of (srcItems ?? []) as SrcItem[]) {
        if (
          !skippedItemIds.has(it.id) &&
          it.parent_id &&
          skippedItemIds.has(it.parent_id)
        ) {
          skippedItemIds.add(it.id)
          changed = true
        }
      }
    }
  }
  const keptItems = ((srcItems ?? []) as SrcItem[]).filter(
    (it) => !skippedItemIds.has(it.id)
  )

  // Compute the date shift, if any. The requested start date is the CRM's
  // Projected Start Date; we anchor the whole schedule on the Job Start
  // milestone so it lands exactly on that date (the New House Template ships
  // with a Job Start milestone). If the source has no dated Job Start, fall
  // back to the earliest start_date across all items (due_date-only to-dos
  // contribute via their due_date).
  let shiftDays = 0
  if (parsed.new_start_date) {
    const jobStart = keptItems.find((it) => it.milestone === "job_start")
    let anchor: string | null = jobStart
      ? jobStart.start_date ?? jobStart.end_date ?? jobStart.due_date
      : null
    if (!anchor) {
      for (const it of keptItems) {
        const candidate = it.start_date ?? it.due_date
        if (candidate && (!anchor || candidate < anchor)) anchor = candidate
      }
    }
    if (anchor) {
      const a = new Date(anchor + "T00:00:00Z").getTime()
      const b = new Date(parsed.new_start_date + "T00:00:00Z").getTime()
      shiftDays = Math.round((b - a) / 86400000)
    }
  }
  const shift = (d: string | null): string | null =>
    d ? addDays(d, shiftDays) : null

  // 1. Insert the new project shell. Optional override_* fields let the
  //    caller layer dashboard-provided identity on top of the template's
  //    defaults. `undefined` falls back to source; explicit null overrides
  //    to empty.
  const ovr = <T,>(o: T | undefined | null, fallback: T): T =>
    o === undefined ? fallback : (o as T)
  // Mirror the CRM's status for the new job (keyed on its number) so a
  // template-built job matches the dashboard from birth. The CRM is the source
  // of truth for status, so it wins over both the caller's override_status and
  // the template's own status; when the CRM has no row (plain duplicate, or CRM
  // unconfigured) we fall back to those, preserving prior behavior.
  const crmStatus = await getCrmProjectStatus(parsed.new_project_number)
  const insertProject = {
    project_number: parsed.new_project_number,
    name: parsed.new_name,
    address: ovr(parsed.override_address, source.address),
    status: crmStatus?.mapped ?? parsed.override_status ?? source.status,
    crm_status: crmStatus?.crmStatus ?? null,
    crm_status_synced_at: crmStatus ? new Date().toISOString() : null,
    project_type: ovr(parsed.override_project_type, source.project_type),
    contract_price: ovr(parsed.override_contract_price, source.contract_price),
    start_date: parsed.new_start_date ?? source.start_date,
    dashboard_url:
      parsed.override_dashboard_url !== undefined
        ? parsed.override_dashboard_url
        : dashboardProjectUrl(parsed.new_project_number),
    project_manager: ovr(parsed.override_project_manager, source.project_manager),
    notes: ovr(parsed.override_notes, source.notes),
    client_name: ovr(parsed.override_client_name, source.client_name),
    client_email: ovr(parsed.override_client_email, source.client_email),
    client_phone: ovr(parsed.override_client_phone, source.client_phone),
    client_name_2: ovr(parsed.override_client_name_2, source.client_name_2),
    client_email_2: ovr(parsed.override_client_email_2, source.client_email_2),
    client_phone_2: ovr(parsed.override_client_phone_2, source.client_phone_2),
    dashboard_pulled_at: parsed.override_dashboard_pulled_at ?? null,
    // Persist the house-attribute answers so it's auditable later why a
    // given template item was or wasn't copied. Plain duplicates (no
    // answers) carry the source project's stored profile forward.
    attributes: parsed.attributes ?? source.attributes ?? {},
    // Carry the cost-plus designation so a duplicated cost-plus job keeps
    // tracking labor hours instead of silently reverting to fixed-price.
    cost_plus: source.cost_plus ?? false,
    // A job built FROM a template is a real job, never itself a template —
    // don't inherit the source's is_template flag.
    is_template: false,
    created_by: profile.id,
  }
  const { data: newProject, error: pErr } = await supabase
    .from("projects")
    .insert(insertProject)
    .select("*")
    .single()
  if (pErr) {
    throw new Error(
      pErr.code === "23505"
        ? `Project number "${parsed.new_project_number}" already exists`
        : pErr.message
    )
  }

  // Every insert below is a child of the new project. A mid-clone failure
  // used to strand a partial project whose number then blocked a retry
  // ("already exists") — so child-table failures compensate: delete the new
  // project shell (children cascade away with it) and rethrow. Attachment
  // blobs already copied under the new project's paths may orphan in the
  // private bucket; accepted, same policy as discarded onsite drafts. If the
  // cleanup delete itself fails we're no worse off than before — warn and
  // surface the original error.
  const failClone = async (message: string): Promise<never> => {
    const { error: cleanupErr } = await supabase
      .from("projects")
      .delete()
      .eq("id", newProject.id)
    if (cleanupErr) {
      console.warn(
        `[duplicateProject] cleanup after failed clone also failed: ${cleanupErr.message} (project ${newProject.id} left partial)`
      )
    }
    throw new Error(message)
  }

  // 2. Insert schedule_items. We pre-assign each new row a UUID
  //    (crypto.randomUUID()) on the client side so we can build the old→new
  //    ID table deterministically — Supabase's batch INSERT doesn't preserve
  //    order on RETURNING, and matching by (position, kind, title) can
  //    collide when two top-level work items share position 0.
  //    parent_id is filled in pass 2 because a to-do's parent is another
  //    schedule_item (which doesn't exist until pass 1 commits).
  const idMap = new Map<string, string>()
  if (keptItems.length > 0) {
    const firstPass = keptItems.map((it) => {
      const newId = crypto.randomUUID()
      idMap.set(it.id, newId)
      let sStart = shift(it.start_date)
      let sEnd = shift(it.end_date)
      let dur = it.duration_days
      // Milestones copy as single-day markers (Job Start keeps its start,
      // Substantial Completion its end) so the target job's milestones match
      // the "1 day" rule enforced everywhere else.
      if (it.milestone && sStart && sEnd && sStart !== sEnd) {
        if (it.milestone === "substantial_completion") sStart = sEnd
        else sEnd = sStart
      }
      if (it.milestone && sStart && sEnd) dur = 1
      return {
        id: newId,
        project_id: newProject.id,
        parent_id: null,
        kind: it.kind,
        title: it.title,
        description: it.description,
        start_date: sStart,
        end_date: sEnd,
        due_date: shift(it.due_date),
        duration_days: dur,
        status: "not_started" as const,
        position: it.position,
        recurrence_rule: it.recurrence_rule,
        // Milestone markers (Job Start / Substantial Completion) copy over;
        // baselines deliberately don't — a new job locks its own baseline
        // via "Set baseline" once the schedule is settled.
        milestone: it.milestone,
        baseline_start_date: null,
        baseline_end_date: null,
        // Carry the conditions along so a duplicated template is still a
        // working template. Inert on regular projects.
        template_tags: it.template_tags,
        created_by: profile.id,
      }
    })
    const { error: iErr } = await supabase
      .from("schedule_items")
      .insert(firstPass)
    if (iErr) await failClone(iErr.message)

    // Pass 2: parent_id fixups for to-dos that nested under a work item.
    // The anchor pair rides along here, not in pass 1 — the DB check
    // constraint requires parent_id to be set alongside it, and without
    // the pair an anchored to-do would degrade to a fixed due date that
    // stops following parent moves.
    const reparents = keptItems
      .filter((s) => s.parent_id && idMap.has(s.id) && idMap.has(s.parent_id))
      .map((s) => ({
        id: idMap.get(s.id)!,
        parent_id: idMap.get(s.parent_id!)!,
        parent_anchor: s.parent_anchor,
        parent_offset_days: s.parent_offset_days,
      }))
    for (const r of reparents) {
      const { error: upErr } = await supabase
        .from("schedule_items")
        .update({
          parent_id: r.parent_id,
          parent_anchor: r.parent_anchor,
          parent_offset_days: r.parent_offset_days,
        })
        .eq("id", r.id)
      if (upErr) await failClone(upErr.message)
    }
  }

  // 3. Copy todo checklists (rows joined through schedule_items so we already
  //    stripped to only the source project). For each, map old schedule_item_id
  //    to the new one.
  type ChecklistRow = Tables<"todo_checklist_items"> & {
    schedule_items?: unknown
  }
  const checklistRows = (srcChecklist ?? []) as ChecklistRow[]
  const newChecklists = checklistRows
    .map((c) => {
      const newSiId = idMap.get(c.schedule_item_id)
      if (!newSiId) return null
      return {
        schedule_item_id: newSiId,
        label: c.label,
        is_done: false, // reset progress on duplicate
        position: c.position,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (newChecklists.length) {
    const { error: cErr } = await supabase
      .from("todo_checklist_items")
      .insert(newChecklists)
    if (cErr) await failClone(cErr.message)
  }

  // 3b. Copy role-based schedule assignments, mapping schedule_item_id through
  //     idMap. Assignments on items the smart-template filter skipped fall out
  //     naturally (idMap has no entry for them). De-dupe on (item, role) so a
  //     source with two identical rows doesn't trip the unique index.
  type RoleAssignRow = Tables<"schedule_assignments"> & {
    schedule_items?: unknown
  }
  const roleAssignRows = (srcRoleAssignments ?? []) as RoleAssignRow[]
  const seenRoleAssign = new Set<string>()
  const newRoleAssignments = roleAssignRows
    .map((a) => {
      const newItem = idMap.get(a.schedule_item_id)
      if (!newItem || !a.role_id) return null
      const key = `${newItem}|${a.role_id}`
      if (seenRoleAssign.has(key)) return null
      seenRoleAssign.add(key)
      return { schedule_item_id: newItem, role_id: a.role_id }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (newRoleAssignments.length) {
    const { error: raErr } = await supabase
      .from("schedule_assignments")
      .insert(newRoleAssignments)
    if (raErr) await failClone(raErr.message)
  }

  // 3c. Copy project role members — the "who fills each role" map (Project
  //     Manager, Site Superintendent, and every trade role). Roles are
  //     org-wide, so the role_id carries over directly; only project_id changes
  //     and the profile/company assignee copies verbatim. This is what makes a
  //     job built from the Template inherit the Template's role assignments
  //     (the same people / companies in the same roles). The PK is
  //     (project_id, role_id) and the source rows are already unique per role.
  type RoleMemberRow = Pick<
    Tables<"project_role_members">,
    "role_id" | "profile_id" | "company_id"
  >
  const roleMemberRows = (srcRoleMembers ?? []) as RoleMemberRow[]
  const newRoleMembers = roleMemberRows.map((m) => ({
    project_id: newProject.id,
    role_id: m.role_id,
    profile_id: m.profile_id,
    company_id: m.company_id,
    updated_by: profile.id,
  }))
  if (newRoleMembers.length) {
    const { error: rmErr } = await supabase
      .from("project_role_members")
      .insert(newRoleMembers)
    if (rmErr) await failClone(rmErr.message)
  }

  // 4. Copy predecessor edges, mapping both ends through idMap. Items the
  //    smart-template filter skipped are spliced out of the dependency
  //    graph first: if Waterproofing sat between Foundation and Backfill
  //    and gets skipped, Backfill inherits Foundation as its predecessor
  //    (lags summed, downstream edge's dep_type kept) so cascading still
  //    flows through the chain. Splicing a DAG node can't create a cycle;
  //    self-edges are dropped and duplicates de-duped.
  type PredRow = Tables<"schedule_predecessors"> & {
    schedule_items?: unknown
  }
  const predRows = (srcPreds ?? []) as PredRow[]
  type Edge = {
    item_id: string
    predecessor_id: string
    dep_type: PredRow["dep_type"]
    lag_days: number
  }
  let edges: Edge[] = predRows.map((p) => ({
    item_id: p.item_id,
    predecessor_id: p.predecessor_id,
    dep_type: p.dep_type,
    lag_days: p.lag_days,
  }))
  for (const skippedId of skippedItemIds) {
    const incoming = edges.filter((e) => e.item_id === skippedId)
    const outgoing = edges.filter((e) => e.predecessor_id === skippedId)
    edges = edges.filter(
      (e) => e.item_id !== skippedId && e.predecessor_id !== skippedId
    )
    for (const out of outgoing) {
      for (const inc of incoming) {
        if (inc.predecessor_id === out.item_id) continue
        edges.push({
          item_id: out.item_id,
          predecessor_id: inc.predecessor_id,
          dep_type: out.dep_type,
          lag_days: inc.lag_days + out.lag_days,
        })
      }
    }
  }
  // One edge per (item, predecessor) pair — the table's PK. When splicing
  // collapses two parallel skipped branches onto the same pair, keep the
  // strictest (largest) lag rather than whichever the unordered source
  // query produced first; ties break on dep_type so the result is
  // deterministic either way.
  const mergedEdges = new Map<
    string,
    { item_id: string; predecessor_id: string; dep_type: PredRow["dep_type"]; lag_days: number }
  >()
  for (const p of edges) {
    const newItem = idMap.get(p.item_id)
    const newPred = idMap.get(p.predecessor_id)
    if (!newItem || !newPred) continue
    const key = `${newItem}|${newPred}`
    const existing = mergedEdges.get(key)
    if (
      !existing ||
      p.lag_days > existing.lag_days ||
      (p.lag_days === existing.lag_days && p.dep_type < existing.dep_type)
    ) {
      mergedEdges.set(key, {
        item_id: newItem,
        predecessor_id: newPred,
        dep_type: p.dep_type,
        lag_days: p.lag_days,
      })
    }
  }
  const newPreds = [...mergedEdges.values()]
  if (newPreds.length) {
    const { error: ePerr } = await supabase
      .from("schedule_predecessors")
      .insert(newPreds)
    if (ePerr) await failClone(ePerr.message)
  }

  // 5. Copy decisions (change orders + selections) with their child rows.
  //    Templates are most useful when they carry their standard
  //    selection set: paint, fixtures, finishes, etc. Same pattern as
  //    schedule_items — pre-assign IDs so we can map child rows back
  //    without a RETURNING-order assumption.
  //    Reset on copy: status → 'draft', approved_at → null,
  //                   approved_by_client_id → null,
  //                   number → re-allocated 1..N in source order.
  type DecisionRow = Tables<"decisions">
  type ChoiceRow = Tables<"decision_choices"> & { decisions?: unknown }
  type CostItemRow = Tables<"decision_cost_items"> & { decisions?: unknown }
  type FollowupRow = Tables<"decision_followup_templates"> & {
    decisions?: unknown
  }
  type AttachmentRow = Tables<"decision_attachments"> & { decisions?: unknown }

  // Smart-template filter, mirroring the schedule items: tag mismatches are
  // dropped, and the review step's per-selection answers can drop a
  // selection that isn't in this contract (include: false) or replace the
  // template's placeholder allowance with the contract's real number.
  const overrideByDecision = new Map(
    (parsed.selection_overrides ?? []).map((o) => [o.decision_id, o])
  )
  const decisionRows = ((srcDecisions ?? []) as DecisionRow[]).filter((d) => {
    if (attrs && !matchesTemplateTags(d.template_tags, attrs)) return false
    return overrideByDecision.get(d.id)?.include !== false
  })
  const decisionIdMap = new Map<string, string>()
  const choiceIdMap = new Map<string, string>()
  let decisionsCopied = 0
  let costItemsCopied = 0
  let followupsCopied = 0
  let attachmentsCopied = 0

  if (decisionRows.length > 0) {
    const newDecisions = decisionRows.map((d, i) => {
      const newId = crypto.randomUUID()
      decisionIdMap.set(d.id, newId)
      // Allowance: an explicit override wins (its null means "no allowance
      // on this contract" — also drop the cost code so we don't keep a
      // code without an amount); otherwise the template's value carries.
      const override = overrideByDecision.get(d.id)
      const allowanceAmount =
        override !== undefined ? override.allowance_amount ?? null : d.allowance_amount
      // Due-date links remap through idMap like follow-up anchors do below —
      // the schedule was cloned above, so the link can follow. If the anchor
      // item was skipped by the template filter, drop the whole triple
      // (all-or-nothing check constraint) and the shifted fixed date remains.
      const newDueAnchor = d.due_anchor_schedule_item_id
        ? idMap.get(d.due_anchor_schedule_item_id) ?? null
        : null
      return {
        id: newId,
        project_id: newProject.id,
        // Per-project sequential numbers re-allocated 1..N. Safe here
        // because the destination project is brand new — no other staff
        // can be racing to insert decisions yet.
        number: i + 1,
        kind: d.kind,
        title: d.title,
        description: d.description,
        // Selections derive cost_delta from the chosen choice on approval;
        // copying the source's value would leak a stale price into the new
        // project's pricing rollup (matches copyDecision's behavior).
        cost_delta: d.kind === "selection" ? null : d.cost_delta,
        markup_percent: d.markup_percent,
        delay_days: d.delay_days,
        delay_cost_per_day: d.delay_cost_per_day,
        allowance_amount: allowanceAmount,
        allowance_cost_code_id:
          allowanceAmount == null ? null : d.allowance_cost_code_id,
        due_date: shift(d.due_date),
        due_anchor_schedule_item_id: newDueAnchor,
        due_anchor: newDueAnchor ? d.due_anchor : null,
        due_anchor_offset_days: newDueAnchor ? d.due_anchor_offset_days : null,
        template_tags: d.template_tags,
        status: "draft" as const,
        approved_at: null,
        approved_by_client_id: null,
        created_by: profile.id,
      }
    })
    const { error: dErr } = await supabase.from("decisions").insert(newDecisions)
    if (dErr) await failClone(dErr.message)
    decisionsCopied = newDecisions.length

    // Choices — copied before cost items / attachments so their per-choice
    // rows can be remapped through choiceIdMap. selected_choice_id stays
    // null (the clone is a draft awaiting a fresh client decision).
    const choiceRows = (srcChoices ?? []) as ChoiceRow[]
    const newChoices = choiceRows
      .map((c) => {
        const newDecisionId = decisionIdMap.get(c.decision_id)
        if (!newDecisionId) return null
        const newId = crypto.randomUUID()
        choiceIdMap.set(c.id, newId)
        return {
          id: newId,
          decision_id: newDecisionId,
          title: c.title,
          description: c.description,
          price_delta: c.price_delta,
          position: c.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newChoices.length > 0) {
      const { error: chErr } = await supabase
        .from("decision_choices")
        .insert(newChoices)
      if (chErr) await failClone(chErr.message)
    }

    // Cost items — map decision_id through decisionIdMap. Skip rows
    // whose decision didn't get copied (defensive — shouldn't happen
    // since both come from the same project).
    const costItemRows = (srcCostItems ?? []) as CostItemRow[]
    const newCostItems = costItemRows
      .map((ci) => {
        const newDecisionId = decisionIdMap.get(ci.decision_id)
        if (!newDecisionId) return null
        return {
          decision_id: newDecisionId,
          // Per-choice line items follow their choice; the composite FK
          // (0018) requires the mapped pair to match, which it does by
          // construction.
          choice_id: ci.choice_id
            ? choiceIdMap.get(ci.choice_id) ?? null
            : null,
          cost_code_id: ci.cost_code_id,
          description: ci.description,
          quantity: ci.quantity,
          unit: ci.unit,
          unit_cost: ci.unit_cost,
          // Catalog links are bare uuids into the separate SpecMagician
          // project — valid across projects, so they copy verbatim (0076).
          catalog_item_id: ci.catalog_item_id,
          catalog_item_code: ci.catalog_item_code,
          position: ci.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newCostItems.length > 0) {
      const { error: ciErr } = await supabase
        .from("decision_cost_items")
        .insert(newCostItems)
      if (ciErr) await failClone(ciErr.message)
      costItemsCopied = newCostItems.length
    }

    // Follow-up templates — assignee_profile_id and assignee_company_id
    // pass through unchanged. Same staff / subs work across projects.
    const followupRows = (srcFollowups ?? []) as FollowupRow[]
    const newFollowups = followupRows
      .map((f) => {
        const newDecisionId = decisionIdMap.get(f.decision_id)
        if (!newDecisionId) return null
        // Schedule-item anchors remap through idMap — the schedule was
        // cloned above, so the anchor can follow. If the anchor item was
        // skipped by the template filter, drop the whole anchor triple
        // (all-or-nothing check constraint) and the due_offset_days
        // fallback takes over at materialization.
        const newAnchor = f.anchor_schedule_item_id
          ? idMap.get(f.anchor_schedule_item_id) ?? null
          : null
        return {
          decision_id: newDecisionId,
          title: f.title,
          kind: f.kind,
          assignee_profile_id: f.assignee_profile_id,
          assignee_company_id: f.assignee_company_id,
          due_offset_days: f.due_offset_days,
          duration_days: f.duration_days,
          anchor_schedule_item_id: newAnchor,
          parent_anchor: newAnchor ? f.parent_anchor : null,
          parent_offset_days: newAnchor ? f.parent_offset_days : null,
          notes: f.notes,
          position: f.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newFollowups.length > 0) {
      const { error: fErr } = await supabase
        .from("decision_followup_templates")
        .insert(newFollowups)
      if (fErr) await failClone(fErr.message)
      followupsCopied = newFollowups.length
    }

    // Attachments — copy each storage object to a fresh path under the
    // new project, then insert the attachment row pointing at the new
    // path. We don't reuse the source path: deleting either decision
    // later would otherwise remove a blob the other one still references.
    // Storage failures are logged but don't abort the clone — staff can
    // re-upload the missing files.
    const attachmentRows = (srcAttachments ?? []) as AttachmentRow[]
    for (const a of attachmentRows) {
      const newDecisionId = decisionIdMap.get(a.decision_id)
      if (!newDecisionId) continue
      const ext = a.storage_path.split(".").pop() ?? "bin"
      const newPath = `projects/${newProject.id}/decisions/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`
      const { error: copyErr } = await supabase.storage
        .from(a.storage_bucket)
        .copy(a.storage_path, newPath)
      if (copyErr) {
        console.warn(
          `[duplicateProject] storage copy failed for ${a.storage_path}: ${copyErr.message} (skipping)`
        )
        continue
      }
      const { error: aErr } = await supabase
        .from("decision_attachments")
        .insert({
          decision_id: newDecisionId,
          // Per-choice photos follow their (re-mapped) choice.
          choice_id: a.choice_id ? choiceIdMap.get(a.choice_id) ?? null : null,
          storage_bucket: a.storage_bucket,
          storage_path: newPath,
          file_name: a.file_name,
          file_type: a.file_type,
          file_size: a.file_size,
          caption: a.caption,
          tags: a.tags,
          position: a.position,
        })
      if (aErr) {
        console.warn(
          `[duplicateProject] attachment row insert failed: ${aErr.message} (orphaned ${newPath})`
        )
        continue
      }
      attachmentsCopied++
    }
  }

  // 5b. Safety net: a source that somehow lacks the protected milestones
  //     still yields a complete project (the copy normally carries them).
  try {
    await ensureProjectMilestones({ project_id: newProject.id })
  } catch (e) {
    console.warn(
      "[duplicateProject] milestone ensure failed:",
      e instanceof Error ? e.message : e
    )
  }

  // 5c. Copy purchase orders as fresh drafts. Every workflow field resets:
  //     status → draft, token/release/approval/decline/void state cleared,
  //     work_complete off, numbers re-allocated 1..N in source-number order
  //     (safe on a brand-new project, same as decisions). Void POs are dead
  //     records and don't copy. Provenance: source_decision_id remaps through
  //     the decisions cloned above; source_bid_recipient_id is dropped — the
  //     copied bid package is a fresh draft, so an award link would claim a
  //     bid round that never happened on this job.
  type PoRow = Tables<"purchase_orders">
  type PoLineRow = Tables<"po_line_items"> & { purchase_orders?: unknown }
  type PoAttachmentRow = Tables<"po_attachments"> & { purchase_orders?: unknown }
  const poRows = ((srcPos ?? []) as PoRow[]).filter((p) => p.status !== "void")
  const poIdMap = new Map<string, string>()
  let purchasingAttachmentsCopied = 0
  let purchasingAttachmentsFailed = 0
  if (poRows.length > 0) {
    const newPos = poRows.map((p, i) => {
      const newId = crypto.randomUUID()
      poIdMap.set(p.id, newId)
      return {
        id: newId,
        project_id: newProject.id,
        number: i + 1,
        custom_number: p.custom_number,
        title: p.title,
        scope: p.scope,
        company_id: p.company_id,
        status: "draft" as const,
        approval_deadline: shift(p.approval_deadline),
        flat_fee: p.flat_fee,
        flat_total: p.flat_total,
        source_decision_id: p.source_decision_id
          ? decisionIdMap.get(p.source_decision_id) ?? null
          : null,
        created_by: profile.id,
      }
    })
    const { error: poErr } = await supabase.from("purchase_orders").insert(newPos)
    if (poErr) await failClone(poErr.message)

    const poLineRows = (srcPoLines ?? []) as PoLineRow[]
    const newPoLines = poLineRows
      .map((li) => {
        const newPoId = poIdMap.get(li.purchase_order_id)
        if (!newPoId) return null
        return {
          purchase_order_id: newPoId,
          cost_code_id: li.cost_code_id,
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unit_cost: li.unit_cost,
          position: li.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newPoLines.length > 0) {
      const { error: pliErr } = await supabase
        .from("po_line_items")
        .insert(newPoLines)
      if (pliErr) await failClone(pliErr.message)
    }
  }

  // 5d. Copy bid packages (bid requests) as fresh drafts. Statuses, send
  //     timestamps, and awards reset; numbers re-allocate 1..N. The invite
  //     list (recipients) carries over as 'invited' with NO token — tokens
  //     are minted when staff actually send the package, so nothing leaks a
  //     live link. Quotes deliberately don't copy: prices belong to the old
  //     job's bid round.
  type BidPackageRow = Tables<"bid_packages">
  type BidLineRow = Tables<"bid_package_line_items"> & { bid_packages?: unknown }
  type BidRecipientRow = Tables<"bid_recipients"> & { bid_packages?: unknown }
  type BidAttachmentRow = Tables<"bid_package_attachments"> & {
    bid_packages?: unknown
  }
  const bidPackageRows = (srcBidPackages ?? []) as BidPackageRow[]
  const bidIdMap = new Map<string, string>()
  let bidRecipientsCopied = 0
  if (bidPackageRows.length > 0) {
    const newPackages = bidPackageRows.map((b, i) => {
      const newId = crypto.randomUUID()
      bidIdMap.set(b.id, newId)
      return {
        id: newId,
        project_id: newProject.id,
        number: i + 1,
        title: b.title,
        scope: b.scope,
        due_date: shift(b.due_date),
        flat_fee: b.flat_fee,
        allow_multiple_awards: b.allow_multiple_awards,
        status: "draft" as const,
        created_by: profile.id,
      }
    })
    const { error: bpErr } = await supabase
      .from("bid_packages")
      .insert(newPackages)
    if (bpErr) await failClone(bpErr.message)

    const bidLineRows = (srcBidLines ?? []) as BidLineRow[]
    const newBidLines = bidLineRows
      .map((li) => {
        const newBidId = bidIdMap.get(li.bid_package_id)
        if (!newBidId) return null
        return {
          bid_package_id: newBidId,
          cost_code_id: li.cost_code_id,
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          position: li.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newBidLines.length > 0) {
      const { error: bliErr } = await supabase
        .from("bid_package_line_items")
        .insert(newBidLines)
      if (bliErr) await failClone(bliErr.message)
    }

    const bidRecipientRows = (srcBidRecipients ?? []) as BidRecipientRow[]
    const newRecipients = bidRecipientRows
      .map((r) => {
        const newBidId = bidIdMap.get(r.bid_package_id)
        if (!newBidId) return null
        return {
          bid_package_id: newBidId,
          company_id: r.company_id,
          status: "invited" as const,
          notes: r.notes,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newRecipients.length > 0) {
      const { error: brErr } = await supabase
        .from("bid_recipients")
        .insert(newRecipients)
      if (brErr) await failClone(brErr.message)
      bidRecipientsCopied = newRecipients.length
    }
  }

  // 5e. Purchasing attachments (both modules) — blob-copy to a fresh path
  //     under the new project, same as decision attachments: reusing the
  //     source path would let one side's delete strand the other. Files-tab
  //     links (project_file_id, 0095) drop on copy — project_files aren't
  //     cloned here, and the documented cross-project rule is blob-copy +
  //     drop-link. Storage failures warn and skip, never abort the clone.
  const copyPurchasingAttachment = async (
    a: PoAttachmentRow | BidAttachmentRow,
    target:
      | { table: "po_attachments"; purchase_order_id: string }
      | { table: "bid_package_attachments"; bid_package_id: string },
    pathSegment: "purchase-orders" | "bids"
  ) => {
    const ext = a.storage_path.split(".").pop() ?? "bin"
    const newPath = `projects/${newProject.id}/${pathSegment}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`
    const { error: copyErr } = await supabase.storage
      .from(a.storage_bucket)
      .copy(a.storage_path, newPath)
    if (copyErr) {
      console.warn(
        `[duplicateProject] storage copy failed for ${a.storage_path}: ${copyErr.message} (skipping)`
      )
      purchasingAttachmentsFailed++
      return
    }
    const base = {
      storage_bucket: a.storage_bucket,
      storage_path: newPath,
      file_name: a.file_name,
      file_type: a.file_type,
      file_size: a.file_size,
      caption: a.caption,
      position: a.position,
    }
    const { error: insErr } =
      target.table === "po_attachments"
        ? await supabase
            .from("po_attachments")
            .insert({ ...base, purchase_order_id: target.purchase_order_id })
        : await supabase
            .from("bid_package_attachments")
            .insert({ ...base, bid_package_id: target.bid_package_id })
    if (insErr) {
      console.warn(
        `[duplicateProject] ${target.table} row insert failed: ${insErr.message} (orphaned ${newPath})`
      )
      purchasingAttachmentsFailed++
      return
    }
    purchasingAttachmentsCopied++
  }
  for (const a of (srcPoAttachments ?? []) as PoAttachmentRow[]) {
    const newPoId = poIdMap.get(a.purchase_order_id)
    if (!newPoId) continue
    await copyPurchasingAttachment(
      a,
      { table: "po_attachments", purchase_order_id: newPoId },
      "purchase-orders"
    )
  }
  for (const a of (srcBidAttachments ?? []) as BidAttachmentRow[]) {
    const newBidId = bidIdMap.get(a.bid_package_id)
    if (!newBidId) continue
    await copyPurchasingAttachment(
      a,
      { table: "bid_package_attachments", bid_package_id: newBidId },
      "bids"
    )
  }

  // 6. Fire the dashboard webhook for the new project (mirrors createProject).
  await sendDashboardWebhook("project.created", newProject)

  revalidatePath("/projects")
  return {
    id: newProject.id,
    itemsCopied: idMap.size,
    itemsSkipped: skippedItemIds.size,
    checklistsCopied: newChecklists.length,
    roleMembersCopied: newRoleMembers.length,
    predecessorsCopied: newPreds.length,
    decisionsCopied,
    decisionsSkipped: (srcDecisions?.length ?? 0) - decisionsCopied,
    costItemsCopied,
    followupsCopied,
    attachmentsCopied,
    purchaseOrdersCopied: poIdMap.size,
    bidPackagesCopied: bidIdMap.size,
    bidRecipientsCopied,
    purchasingAttachmentsCopied,
    // Non-zero when a bid/PO attachment blob failed to copy (the clone still
    // succeeds) — surfaced in the duplicate toast so a clean success can't
    // silently omit files.
    purchasingAttachmentsFailed,
  }
}

// ---------------------------------------------------------------------------
// Template profile (smart-template questionnaire data)
// ---------------------------------------------------------------------------

export type TemplateProfile = {
  /** Distinct base tags across the template's items — one yes/no question each. */
  tags: string[]
  /** The template's selections, for the include/allowance review step. */
  selections: {
    id: string
    title: string
    allowance_amount: number | null
    template_tags: string[]
  }[]
}

/**
 * What the duplicate flow needs to render the smart-template steps for a
 * given source project: the house-attribute questions (derived from the
 * template_tags actually present, so tagging a new item automatically adds
 * its question) and the selections to review against the contract.
 */
export async function getTemplateProfile(input: {
  source_project_id: string
}): Promise<TemplateProfile> {
  await requireStaff()
  const parsed = z
    .object({ source_project_id: z.string() })
    .parse(input)
  const supabase = await createSupabaseServerClient()
  const [
    { data: items, error: iErr },
    { data: decisions, error: dErr },
  ] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("template_tags")
      .eq("project_id", parsed.source_project_id),
    supabase
      .from("decisions")
      .select("id, title, kind, allowance_amount, template_tags")
      .eq("project_id", parsed.source_project_id)
      .order("number", { ascending: true }),
  ])
  const err = iErr ?? dErr
  if (err) throw new Error(err.message)
  return {
    tags: collectBaseTags(
      [...(items ?? []), ...(decisions ?? [])].map((r) => r.template_tags)
    ),
    selections: (decisions ?? [])
      .filter((d) => d.kind === "selection")
      .map((d) => ({
        id: d.id,
        title: d.title,
        allowance_amount: d.allowance_amount,
        template_tags: d.template_tags,
      })),
  }
}
