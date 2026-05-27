"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { addDays } from "@/lib/utils"
import {
  dashboardProjectUrl,
  getDashboardProject,
  sendDashboardWebhook,
} from "@/lib/dashboard"
import type { Tables } from "@/lib/db/types"

const ProjectInput = z.object({
  project_number: z.string().min(1, "Required").max(64),
  name: z.string().min(1, "Required").max(200),
  address: z.string().max(500).optional().or(z.literal("")),
  status: z
    .enum(["lead", "pre_construction", "active", "on_hold", "complete", "cancelled"])
    .default("active"),
  contract_price: z.coerce.number().nonnegative().nullable().optional(),
  start_date: z.string().optional().or(z.literal("")),
  target_completion_date: z.string().optional().or(z.literal("")),
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
  // Jobsite coordinates for the onsite check-in geofence. Pasted from
  // Google Maps by staff; both must be present to count as set.
  latitude: z.coerce
    .number()
    .min(-90)
    .max(90)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  longitude: z.coerce
    .number()
    .min(-180)
    .max(180)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  // "1" if this came from the dashboard picker. Used to set dashboard_pulled_at
  // server-side so we don't trust a client-supplied timestamp.
  dashboard_pulled: z.string().optional().or(z.literal("")),
  // If present, the new project is created by duplicating this source
  // project (template) and then layering the form's identity fields on top.
  source_template_id: z.string().optional().or(z.literal("")),
}).superRefine((val, ctx) => {
  // Coordinates are useless solo — the geofence needs both. Reject a
  // partial pair so we never persist an unusable record.
  const hasLat = val.latitude !== undefined
  const hasLng = val.longitude !== undefined
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLat ? "longitude" : "latitude"],
      message: "Provide both latitude and longitude, or leave both blank",
    })
  }
})

export type ProjectFormState = {
  error?: string
  fieldErrors?: Record<string, string>
}

function emptyToNull<T extends string | undefined | null>(v: T) {
  return v === "" || v == null ? null : v
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

  // If staff didn't paste a URL, auto-derive from the project number so the
  // dashboard link is canonical and immediately shareable with the client.
  const finalDashboardUrl =
    emptyToNull(input.dashboard_url) ?? dashboardProjectUrl(input.project_number)

  // Server-side verify the "this came from the dashboard" claim. The form
  // sends dashboard_pulled=1 when staff used the picker, but we can't trust
  // that flag — a crafted request could set it for any project_number. So
  // we re-fetch the project from the dashboard and only stamp
  // dashboard_pulled_at when the dashboard actually has this project.
  // If the dashboard is unreachable / not configured / the project is no
  // longer there, we silently leave the timestamp NULL (the row still saves
  // — staff get their project, it just looks like a blank-created one).
  let dashboardPulledAt: string | null = null
  if (input.dashboard_pulled === "1") {
    const remote = await getDashboardProject(input.project_number)
    if (remote) dashboardPulledAt = new Date().toISOString()
  }

  // Combo path: copy a template's schedule + decisions, but use the form's
  // identity fields (typically pulled from the dashboard) for the new
  // project shell. duplicateProject does the heavy lifting; we just hand it
  // the overrides. We resolve the new id outside the try/catch so the
  // redirect() throw isn't swallowed (Next 16 redirect throws a special
  // NEXT_REDIRECT error that has to propagate).
  if (input.source_template_id) {
    let templateResult: Awaited<ReturnType<typeof duplicateProject>> | null = null
    try {
      templateResult = await duplicateProject({
        source_project_id: input.source_template_id,
        new_project_number: input.project_number,
        new_name: input.name,
        new_start_date: emptyToNull(input.start_date),
        override_address: emptyToNull(input.address),
        override_status: input.status,
        override_contract_price: input.contract_price ?? null,
        override_target_completion_date: emptyToNull(input.target_completion_date),
        override_dashboard_url: finalDashboardUrl,
        override_notes: emptyToNull(input.notes),
        override_client_name: emptyToNull(input.client_name),
        override_client_email: emptyToNull(input.client_email),
        override_client_phone: emptyToNull(input.client_phone),
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

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("projects")
    .insert({
      project_number: input.project_number,
      name: input.name,
      address: emptyToNull(input.address),
      status: input.status,
      contract_price: input.contract_price ?? null,
      start_date: emptyToNull(input.start_date) ?? null,
      target_completion_date: emptyToNull(input.target_completion_date) ?? null,
      dashboard_url: finalDashboardUrl,
      notes: emptyToNull(input.notes),
      client_name: emptyToNull(input.client_name),
      client_email: emptyToNull(input.client_email),
      client_phone: emptyToNull(input.client_phone),
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
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

  // Best-effort: tell the dashboard a new project exists. Webhook failures
  // never block the redirect — the dashboard can backfill from /projects/[id].
  await sendDashboardWebhook("project.created", data)

  revalidatePath("/projects")
  redirect(`/projects/${data.id}/schedule`)
}

// ---------------------------------------------------------------------------
// Set jobsite coordinates (onsite check-in)
// ---------------------------------------------------------------------------

const CoordinatesInput = z.object({
  project_id: z.string().uuid(),
  // Coerce strings so the inline form on /onsite can post raw FormData values.
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
})

export type SetProjectCoordinatesResult =
  | { ok: true }
  | { ok: false; error: string }

export async function setProjectCoordinates(
  input: z.input<typeof CoordinatesInput>
): Promise<SetProjectCoordinatesResult> {
  await requireStaff()
  const parsed = CoordinatesInput.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "Latitude and longitude must be valid numbers",
    }
  }
  const supabase = await createSupabaseServerClient()
  // .select() forces the update to return the matched row so we can tell a
  // silent zero-rows case (wrong id, or RLS hid it) apart from a real save.
  const { data, error } = await supabase
    .from("projects")
    .update({
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
    })
    .eq("id", parsed.data.project_id)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Project not found." }
  revalidatePath(`/projects/${parsed.data.project_id}/onsite`)
  return { ok: true }
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
      .enum(["lead", "pre_construction", "active", "on_hold", "complete", "cancelled"])
      .optional(),
    override_contract_price: z.number().nullable().optional(),
    override_target_completion_date: z.string().nullish(),
    override_dashboard_url: z.string().nullish(),
    override_notes: z.string().nullish(),
    override_client_name: z.string().nullish(),
    override_client_email: z.string().nullish(),
    override_client_phone: z.string().nullish(),
    // Already-verified timestamp (set by createProject after re-fetching
    // from the dashboard). Pass-through — never trust a client-supplied one.
    override_dashboard_pulled_at: z.string().nullish(),
  })
  .passthrough()

export type DuplicateProjectInputT = z.infer<typeof DuplicateProjectInput>

/**
 * Clone a project's structure (schedule items + checklists + predecessors,
 * plus decisions/selections with their cost breakdowns, follow-up templates,
 * and attachments) into a brand-new project. Skips project-specific data:
 * assignments, daily logs, files, payments, project_members, comments.
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
    { data: srcCostItems, error: costItemsErr },
    { data: srcFollowups, error: followupsErr },
    { data: srcAttachments, error: attachmentsErr },
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
    // Cost items + followup templates + attachments are joined through
    // decisions so we only get rows that belong to the source project,
    // regardless of which decisions actually have any.
    supabase
      .from("decision_cost_items")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_followup_templates")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_attachments")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", parsed.source_project_id)
      .order("position", { ascending: true }),
  ])
  const readErr =
    sourceErr ??
    itemsErr ??
    checklistErr ??
    predsErr ??
    decisionsErr ??
    costItemsErr ??
    followupsErr ??
    attachmentsErr
  if (readErr) throw new Error(`Source read failed: ${readErr.message}`)
  if (!source) throw new Error("Source project not found")

  // Compute the date shift, if any. The "source start" is the earliest
  // start_date across all source items; due_date-only to-dos contribute via
  // their due_date as a fallback.
  let shiftDays = 0
  if (parsed.new_start_date) {
    let earliest: string | null = null
    for (const it of srcItems ?? []) {
      const candidate = it.start_date ?? it.due_date
      if (candidate && (!earliest || candidate < earliest)) earliest = candidate
    }
    if (earliest) {
      const a = new Date(earliest + "T00:00:00Z").getTime()
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
  const insertProject = {
    project_number: parsed.new_project_number,
    name: parsed.new_name,
    address: ovr(parsed.override_address, source.address),
    status: parsed.override_status ?? source.status,
    contract_price: ovr(parsed.override_contract_price, source.contract_price),
    start_date: parsed.new_start_date ?? source.start_date,
    target_completion_date:
      parsed.override_target_completion_date !== undefined
        ? parsed.override_target_completion_date
        : source.target_completion_date
        ? shift(source.target_completion_date)
        : null,
    dashboard_url:
      parsed.override_dashboard_url !== undefined
        ? parsed.override_dashboard_url
        : dashboardProjectUrl(parsed.new_project_number),
    notes: ovr(parsed.override_notes, source.notes),
    client_name: ovr(parsed.override_client_name, source.client_name),
    client_email: ovr(parsed.override_client_email, source.client_email),
    client_phone: ovr(parsed.override_client_phone, source.client_phone),
    dashboard_pulled_at: parsed.override_dashboard_pulled_at ?? null,
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

  // 2. Insert schedule_items. We pre-assign each new row a UUID
  //    (crypto.randomUUID()) on the client side so we can build the old→new
  //    ID table deterministically — Supabase's batch INSERT doesn't preserve
  //    order on RETURNING, and matching by (position, kind, title) can
  //    collide when two top-level work items share position 0.
  //    parent_id is filled in pass 2 because a to-do's parent is another
  //    schedule_item (which doesn't exist until pass 1 commits).
  type Item = Tables<"schedule_items">
  const idMap = new Map<string, string>()
  if (srcItems && srcItems.length > 0) {
    const firstPass = (srcItems as Item[]).map((it) => {
      const newId = crypto.randomUUID()
      idMap.set(it.id, newId)
      return {
        id: newId,
        project_id: newProject.id,
        parent_id: null,
        kind: it.kind,
        title: it.title,
        description: it.description,
        start_date: shift(it.start_date),
        end_date: shift(it.end_date),
        due_date: shift(it.due_date),
        duration_days: it.duration_days,
        status: "not_started" as const,
        position: it.position,
        recurrence_rule: it.recurrence_rule,
        baseline_start_date: shift(it.baseline_start_date),
        baseline_end_date: shift(it.baseline_end_date),
        created_by: profile.id,
      }
    })
    const { error: iErr } = await supabase
      .from("schedule_items")
      .insert(firstPass)
    if (iErr) throw new Error(iErr.message)

    // Pass 2: parent_id fixups for to-dos that nested under a work item.
    const reparents = (srcItems as Item[])
      .filter((s) => s.parent_id && idMap.has(s.id) && idMap.has(s.parent_id))
      .map((s) => ({
        id: idMap.get(s.id)!,
        parent_id: idMap.get(s.parent_id!)!,
      }))
    for (const r of reparents) {
      const { error: upErr } = await supabase
        .from("schedule_items")
        .update({ parent_id: r.parent_id })
        .eq("id", r.id)
      if (upErr) throw new Error(upErr.message)
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
    if (cErr) throw new Error(cErr.message)
  }

  // 4. Copy predecessor edges, mapping both ends through idMap. Skip any
  //    edge whose endpoints didn't make it into the new project (defensive).
  type PredRow = Tables<"schedule_predecessors"> & {
    schedule_items?: unknown
  }
  const predRows = (srcPreds ?? []) as PredRow[]
  const newPreds = predRows
    .map((p) => {
      const newItem = idMap.get(p.item_id)
      const newPred = idMap.get(p.predecessor_id)
      if (!newItem || !newPred) return null
      return {
        item_id: newItem,
        predecessor_id: newPred,
        dep_type: p.dep_type,
        lag_days: p.lag_days,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (newPreds.length) {
    const { error: ePerr } = await supabase
      .from("schedule_predecessors")
      .insert(newPreds)
    if (ePerr) throw new Error(ePerr.message)
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
  type CostItemRow = Tables<"decision_cost_items"> & { decisions?: unknown }
  type FollowupRow = Tables<"decision_followup_templates"> & {
    decisions?: unknown
  }
  type AttachmentRow = Tables<"decision_attachments"> & { decisions?: unknown }

  const decisionRows = (srcDecisions ?? []) as DecisionRow[]
  const decisionIdMap = new Map<string, string>()
  let decisionsCopied = 0
  let costItemsCopied = 0
  let followupsCopied = 0
  let attachmentsCopied = 0

  if (decisionRows.length > 0) {
    const newDecisions = decisionRows.map((d, i) => {
      const newId = crypto.randomUUID()
      decisionIdMap.set(d.id, newId)
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
        cost_delta: d.cost_delta,
        markup_percent: d.markup_percent,
        status: "draft" as const,
        approved_at: null,
        approved_by_client_id: null,
        created_by: profile.id,
      }
    })
    const { error: dErr } = await supabase.from("decisions").insert(newDecisions)
    if (dErr) throw new Error(dErr.message)
    decisionsCopied = newDecisions.length

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
          cost_code_id: ci.cost_code_id,
          description: ci.description,
          quantity: ci.quantity,
          unit: ci.unit,
          unit_cost: ci.unit_cost,
          position: ci.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newCostItems.length > 0) {
      const { error: ciErr } = await supabase
        .from("decision_cost_items")
        .insert(newCostItems)
      if (ciErr) throw new Error(ciErr.message)
      costItemsCopied = newCostItems.length
    }

    // Follow-up templates — assignee_profile_id and assignee_company_id
    // pass through unchanged. Same staff / subs work across projects.
    const followupRows = (srcFollowups ?? []) as FollowupRow[]
    const newFollowups = followupRows
      .map((f) => {
        const newDecisionId = decisionIdMap.get(f.decision_id)
        if (!newDecisionId) return null
        return {
          decision_id: newDecisionId,
          title: f.title,
          assignee_profile_id: f.assignee_profile_id,
          assignee_company_id: f.assignee_company_id,
          due_offset_days: f.due_offset_days,
          notes: f.notes,
          position: f.position,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (newFollowups.length > 0) {
      const { error: fErr } = await supabase
        .from("decision_followup_templates")
        .insert(newFollowups)
      if (fErr) throw new Error(fErr.message)
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
          storage_bucket: a.storage_bucket,
          storage_path: newPath,
          file_name: a.file_name,
          file_type: a.file_type,
          file_size: a.file_size,
          caption: a.caption,
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

  // 6. Fire the dashboard webhook for the new project (mirrors createProject).
  await sendDashboardWebhook("project.created", newProject)

  revalidatePath("/projects")
  return {
    id: newProject.id,
    itemsCopied: idMap.size,
    checklistsCopied: newChecklists.length,
    predecessorsCopied: newPreds.length,
    decisionsCopied,
    costItemsCopied,
    followupsCopied,
    attachmentsCopied,
  }
}
