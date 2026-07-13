"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
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
  // Optional per-project assignment done in the SAME step as the catalog add
  // (the Roles tab "Add a role" form). All three below are ignored unless
  // project_id is supplied; the org-wide catalog row is created either way.
  project_id: z.string().uuid().optional(),
  // "" = leave the role unfilled on this job; "p:<uuid>" a profile;
  // "c:<uuid>" a company (sub/vendor). Mirrors setProjectRole's target.
  target: z
    .string()
    .regex(/^$|^[pc]:[0-9a-fA-F-]{36}$/, "Invalid assignee")
    .default(""),
  // Schedule items (this project) the new role should be assigned to right
  // away. Each becomes a role-based schedule_assignments row.
  schedule_item_ids: z.array(z.string().uuid()).max(1000).default([]),
})

/**
 * Add a role to the catalog. Names are unique case-insensitively (DB index
 * uq_roles_name_lower) — a duplicate returns a friendly error rather than the
 * raw constraint message. New roles sort after the existing ones.
 *
 * When called from a project (project_id set), the same call optionally maps
 * the new role to a person/company on that job (project_role_members) and
 * assigns it to a set of schedule items (role-based schedule_assignments), so
 * staff can define a role AND wire it up in one action. The catalog insert is
 * the only hard failure; a post-create assignment hiccup returns ok with a
 * `warning` (the role still exists and can be assigned from the row UI).
 */
export async function createRole(
  input: z.input<typeof CreateRoleInput>
): Promise<
  | {
      ok: true
      role: Tables<"roles">
      assignedItems: number
      skippedItems: number
      warning?: string
    }
  | { ok: false; error: string }
> {
  const profile = await requireStaff()
  const parsed = CreateRoleInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid role." }
  }
  const { name, kind, project_id, target, schedule_item_ids } = parsed.data
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

  const { data: role, error } = await supabase
    .from("roles")
    .insert({ name, kind, position: nextPos })
    .select("*")
    .single()
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `A role named "${name}" already exists.` }
    }
    return { ok: false, error: error.message }
  }

  let assignedItems = 0
  let skippedItems = 0
  let warning: string | undefined

  if (project_id) {
    // The two writes below are independent — filling the role and assigning it
    // to work don't depend on each other — so each runs and reports on its own,
    // and any failures collect into a single warning rather than short-
    // circuiting the rest.
    const warnings: string[] = []

    // 1. Fill the role on this job (project_role_members) if an assignee was
    //    chosen. Same shape as setProjectRole's upsert.
    if (target !== "") {
      const isProfile = target.startsWith("p:")
      const id = target.slice(2)
      const { error: memberErr } = await supabase
        .from("project_role_members")
        .upsert(
          {
            project_id,
            role_id: role.id,
            profile_id: isProfile ? id : null,
            company_id: isProfile ? null : id,
            updated_by: profile.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id,role_id" }
        )
      if (memberErr) {
        warnings.push(`the assignee couldn't be set (${memberErr.message})`)
      }
    }

    // 2. Assign the role to the chosen schedule items. Scope to this project
    //    so a forged id can't touch another job's rows (mirrors the bulk
    //    assign action). Nothing to dedupe against — the role is brand new.
    //    skippedItems always reflects requested-minus-assigned, so stale ids
    //    (deleted between page load and submit) are reported, not lost.
    if (schedule_item_ids.length > 0) {
      const { data: items, error: itemsErr } = await supabase
        .from("schedule_items")
        .select("id")
        .in("id", schedule_item_ids)
        .eq("project_id", project_id)
      if (itemsErr) {
        warnings.push(`schedule items couldn't be assigned (${itemsErr.message})`)
      } else {
        const validIds = (items ?? []).map((i) => i.id)
        if (validIds.length > 0) {
          const rows = validIds.map((sid) => ({
            schedule_item_id: sid,
            profile_id: null,
            company_id: null,
            role_id: role.id,
          }))
          const { data: inserted, error: insErr } = await supabase
            .from("schedule_assignments")
            .insert(rows)
            .select("schedule_item_id")
          if (insErr) {
            warnings.push(`schedule items couldn't be assigned (${insErr.message})`)
          } else {
            assignedItems = (inserted ?? []).length
          }
        }
      }
      skippedItems = schedule_item_ids.length - assignedItems
    }

    if (warnings.length > 0) {
      warning = `Role created, but ${warnings.join("; ")}.`
    }

    // The resolved assignee/role shows up across the schedule and (for trades)
    // My Assignments, so refresh those alongside the Roles tab.
    revalidatePath(`/projects/${project_id}/roles`)
    revalidatePath(`/projects/${project_id}/schedule`)
    revalidatePath("/my-assignments")
  }

  revalidatePath("/projects", "layout")
  return { ok: true, role, assignedItems, skippedItems, warning }
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
