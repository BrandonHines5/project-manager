"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { addDays } from "@/lib/utils"
import {
  dashboardProjectUrl,
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
  })
  .passthrough()

export type DuplicateProjectInputT = z.infer<typeof DuplicateProjectInput>

/**
 * Clone a project's structure (schedule items + checklists + predecessors)
 * into a brand-new project. Skips project-specific data: assignments,
 * decisions, daily logs, files, payments, project_members.
 *
 * Intended primary use: a "template" project staff maintain as the standard
 * Hines Homes build schedule, duplicated for each new build.
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
  const [
    { data: source },
    { data: srcItems },
    { data: srcChecklist },
    { data: srcPreds },
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
  ])
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

  // 1. Insert the new project shell.
  const insertProject = {
    project_number: parsed.new_project_number,
    name: parsed.new_name,
    address: source.address,
    status: source.status,
    contract_price: source.contract_price,
    start_date: parsed.new_start_date ?? source.start_date,
    target_completion_date: source.target_completion_date
      ? shift(source.target_completion_date)
      : null,
    dashboard_url: dashboardProjectUrl(parsed.new_project_number),
    notes: source.notes,
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

  // 2. Insert schedule_items in TWO passes so we can map old → new IDs and
  //    fix parent_id in pass 2 (a to-do's parent is another schedule_item).
  type Item = Tables<"schedule_items">
  const idMap = new Map<string, string>()
  if (srcItems && srcItems.length > 0) {
    // Pass 1: insert without parent_id, capture new IDs.
    const firstPass = srcItems.map((it: Item) => ({
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
    }))
    const { data: inserted, error: iErr } = await supabase
      .from("schedule_items")
      .insert(firstPass)
      .select("id, title, kind, position")
    if (iErr) throw new Error(iErr.message)
    if (!inserted) throw new Error("schedule_items insert returned no rows")

    // Match inserted back to source rows by (position, kind, title). Position
    // is unique enough in practice; title + kind is the tiebreaker for items
    // that share a position (e.g. multiple top-level work items at position 0).
    const byKey = new Map<string, string>()
    for (const row of inserted) {
      byKey.set(`${row.position}|${row.kind}|${row.title}`, row.id)
    }
    for (const src of srcItems) {
      const newId = byKey.get(`${src.position}|${src.kind}|${src.title}`)
      if (newId) idMap.set(src.id, newId)
    }

    // Pass 2: parent_id fixups for to-dos that nested under a work item.
    const reparents = srcItems
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

  // 5. Fire the dashboard webhook for the new project (mirrors createProject).
  await sendDashboardWebhook("project.created", newProject)

  revalidatePath("/projects")
  return {
    id: newProject.id,
    itemsCopied: idMap.size,
    checklistsCopied: newChecklists.length,
    predecessorsCopied: newPreds.length,
  }
}
