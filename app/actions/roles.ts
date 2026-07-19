"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getActiveOrgId } from "@/lib/org"
import type { Tables } from "@/lib/db/types"

// ---------------------------------------------------------------------------
// Roles — an org-wide catalog of assignable jobs ("Project Manager", "Footings
// Excavator", …) plus the per-project map of role → concrete profile/company
// (project_role_members). A schedule item assigned to a role resolves through
// the per-project map for display and trade visibility. See migration 0054.
// ---------------------------------------------------------------------------

export type RoleActionResult =
  | { ok: true }
  | { ok: false; error: string }

const RoleKind = z.enum(["staff", "company", "any"])

const CreateRoleInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  kind: RoleKind.default("any"),
})

/**
 * Add a role to the catalog. Names are unique case-insensitively (DB index
 * uq_roles_name_lower) — a duplicate returns a friendly error rather than the
 * raw constraint message. New roles sort after the existing ones.
 *
 * This only creates the org-wide catalog row. Filling the role on a job and
 * assigning it to schedule items happens right after in the role dialog via
 * `saveRoleAssignment` (the "Add a role" flow opens that dialog on success).
 */
export async function createRole(
  input: z.input<typeof CreateRoleInput>
): Promise<{ ok: true; role: Tables<"roles"> } | { ok: false; error: string }> {
  await requireStaff()
  const parsed = CreateRoleInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid role." }
  }
  const supabase = await createSupabaseServerClient()

  // Position new roles at the end (max + 1). A small catalog, so a quick
  // read-then-write is fine; uniqueness on the name is what actually matters.
  const { data: last } = await supabase
    .from("roles")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextPos = (last?.position ?? -1) + 1

  const { data, error } = await supabase
    .from("roles")
    .insert({
      org_id: await getActiveOrgId(supabase),
      name: parsed.data.name,
      kind: parsed.data.kind,
      position: nextPos,
    })
    .select("*")
    .single()
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A role named "${parsed.data.name}" already exists.` }
    }
    return { ok: false, error: error.message }
  }
  revalidatePath("/projects", "layout")
  return { ok: true, role: data }
}

const UpdateRoleInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(80),
  kind: RoleKind,
})

/** Rename a role / change which CRM kind usually fills it. */
export async function updateRole(
  input: z.input<typeof UpdateRoleInput>
): Promise<RoleActionResult> {
  await requireStaff()
  const parsed = UpdateRoleInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid role." }
  }
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("roles")
    .update({ name: parsed.data.name, kind: parsed.data.kind })
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle()
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A role named "${parsed.data.name}" already exists.` }
    }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: "Role not found." }
  revalidatePath("/projects", "layout")
  return { ok: true }
}

const DeleteRoleInput = z.object({ id: z.string().uuid() })

/**
 * Remove a role from the catalog. Cascades (FK on delete cascade) to every
 * project's role map AND to schedule_assignments that targeted it, so the
 * caller is warned in the UI before this runs.
 */
export async function deleteRole(
  input: z.input<typeof DeleteRoleInput>
): Promise<RoleActionResult> {
  await requireStaff()
  const parsed = DeleteRoleInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid role." }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("roles").delete().eq("id", parsed.data.id)
  if (error) return { ok: false, error: error.message }
  // Deleting a role cascades to schedule_assignments + project_role_members,
  // so any schedule view and My Assignments could now be stale.
  revalidatePath("/projects", "layout")
  revalidatePath("/my-assignments")
  return { ok: true }
}

// target: "" clears the role for this project; "p:<uuid>" assigns a profile;
// "c:<uuid>" assigns a company.
const SetProjectRoleInput = z.object({
  project_id: z.string().uuid(),
  role_id: z.string().uuid(),
  target: z
    .string()
    .regex(/^$|^[pc]:[0-9a-fA-F-]{36}$/, "Invalid assignee")
    .default(""),
})

/**
 * Assign (or clear) who fills a role on one project. Upserts the
 * project_role_members row keyed by (project_id, role_id); an empty target
 * deletes it (role left unfilled). Changing this updates every schedule item
 * assigned to the role — no per-item edits. Runs under the caller's session so
 * RLS still gates the write.
 */
export async function setProjectRole(
  input: z.input<typeof SetProjectRoleInput>
): Promise<RoleActionResult> {
  const profile = await requireStaff()
  const parsed = SetProjectRoleInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." }
  }
  const { project_id, role_id, target } = parsed.data
  const supabase = await createSupabaseServerClient()

  if (target === "") {
    const { error } = await supabase
      .from("project_role_members")
      .delete()
      .eq("project_id", project_id)
      .eq("role_id", role_id)
    if (error) return { ok: false, error: error.message }
  } else {
    const isProfile = target.startsWith("p:")
    const id = target.slice(2)
    const { error } = await supabase.from("project_role_members").upsert(
      {
        project_id,
        role_id,
        profile_id: isProfile ? id : null,
        company_id: isProfile ? null : id,
        updated_by: profile.id,
        // Bump on upsert so the trigger-managed value is fresh even on the
        // INSERT path (the trigger only fires on UPDATE).
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,role_id" }
    )
    if (error) return { ok: false, error: error.message }
  }

  // The resolved assignee name shows up across the schedule and (for trades)
  // My Assignments, so refresh those alongside the Roles tab.
  revalidatePath(`/projects/${project_id}/roles`)
  revalidatePath(`/projects/${project_id}/schedule`)
  revalidatePath("/my-assignments")
  return { ok: true }
}

const SaveRoleAssignmentInput = z.object({
  project_id: z.string().uuid(),
  role_id: z.string().uuid(),
  // "" clears the assignee; "p:<uuid>" a profile; "c:<uuid>" a company.
  target: z
    .string()
    .regex(/^$|^[pc]:[0-9a-fA-F-]{36}$/, "Invalid assignee")
    .default(""),
  // The FULL set of schedule items this role should be assigned to on this
  // job. The action reconciles to match exactly — checked-but-missing get
  // inserted, previously-assigned-but-unchecked get removed.
  schedule_item_ids: z.array(z.string().uuid()).max(2000).default([]),
})

/**
 * Set who fills a role on a job AND reconcile the role's schedule-item
 * assignments to exactly the given set — the save path for the role dialog
 * (both the just-added role and the Edit button). This is a superset of
 * setProjectRole: it also adds/removes role-based schedule_assignments so a
 * role can be assigned to any work or to-do item after the fact.
 *
 * Runs under the caller's session so RLS still gates every write. All item ids
 * are re-scoped to the project server-side, so a forged id can't touch another
 * job's rows.
 */
export async function saveRoleAssignment(
  input: z.input<typeof SaveRoleAssignmentInput>
): Promise<
  | { ok: true; added: number; removed: number; skipped: number }
  | { ok: false; error: string }
> {
  const profile = await requireStaff()
  const parsed = SaveRoleAssignmentInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." }
  }
  const { project_id, role_id, target, schedule_item_ids } = parsed.data
  const supabase = await createSupabaseServerClient()

  // 1. Assignee (project_role_members) — same upsert/delete as setProjectRole.
  if (target === "") {
    const { error } = await supabase
      .from("project_role_members")
      .delete()
      .eq("project_id", project_id)
      .eq("role_id", role_id)
    if (error) return { ok: false, error: error.message }
  } else {
    const isProfile = target.startsWith("p:")
    const id = target.slice(2)
    const { error } = await supabase.from("project_role_members").upsert(
      {
        project_id,
        role_id,
        profile_id: isProfile ? id : null,
        company_id: isProfile ? null : id,
        updated_by: profile.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,role_id" }
    )
    if (error) return { ok: false, error: error.message }
  }

  // 2. Reconcile schedule-item assignments to the desired set.
  // Desired ids re-scoped to this project (drops forged/stale/foreign ids —
  // the difference is reported as `skipped`).
  const uniqueRequested = Array.from(new Set(schedule_item_ids))
  let desired = new Set<string>()
  if (uniqueRequested.length > 0) {
    const { data: validItems, error: validErr } = await supabase
      .from("schedule_items")
      .select("id")
      .in("id", uniqueRequested)
      .eq("project_id", project_id)
    if (validErr) return { ok: false, error: validErr.message }
    desired = new Set((validItems ?? []).map((i) => i.id))
  }
  const skipped = uniqueRequested.length - desired.size

  // Current role-based assignments among this project's items (join keeps the
  // query bounded without a giant IN list).
  const { data: existing, error: existErr } = await supabase
    .from("schedule_assignments")
    .select("schedule_item_id, schedule_items!inner(project_id)")
    .eq("schedule_items.project_id", project_id)
    .eq("role_id", role_id)
  if (existErr) return { ok: false, error: existErr.message }
  const existingSet = new Set((existing ?? []).map((r) => r.schedule_item_id))

  const toAdd = [...desired].filter((id) => !existingSet.has(id))
  const toRemove = [...existingSet].filter((id) => !desired.has(id))

  let added = 0
  if (toAdd.length > 0) {
    const rows = toAdd.map((sid) => ({
      schedule_item_id: sid,
      profile_id: null,
      company_id: null,
      role_id,
    }))
    const { data: ins, error: insErr } = await supabase
      .from("schedule_assignments")
      .insert(rows)
      .select("schedule_item_id")
    if (insErr) return { ok: false, error: insErr.message }
    added = (ins ?? []).length
  }

  let removed = 0
  if (toRemove.length > 0) {
    const { data: del, error: delErr } = await supabase
      .from("schedule_assignments")
      .delete()
      .eq("role_id", role_id)
      .in("schedule_item_id", toRemove)
      .select("schedule_item_id")
    if (delErr) return { ok: false, error: delErr.message }
    removed = (del ?? []).length
  }

  revalidatePath(`/projects/${project_id}/roles`)
  revalidatePath(`/projects/${project_id}/schedule`)
  revalidatePath("/my-assignments")
  return { ok: true, added, removed, skipped }
}
