"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import type { TablesUpdate } from "@/lib/db/types"

// Empty-string -> null so a cleared date input clears the column.
const nullableDate = z
  .string()
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null))

// ---------------------------------------------------------------------------
// Per-issue (schedule_items) edits
// ---------------------------------------------------------------------------

// Patches only the warranty columns it's handed, so an inline grid edit never
// disturbs the to-do's assignments / checklist / predecessors. Each field is
// applied only when explicitly present.
const WarrantyItemInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().trim().min(1, "Issue is required").max(500).optional(),
  warranty_date_noted: nullableDate,
  warranty_resolution: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  due_date: nullableDate,
  status: z
    .enum(["not_started", "in_progress", "complete", "delayed"])
    .optional(),
})

export async function updateWarrantyItem(
  input: z.input<typeof WarrantyItemInput>
) {
  await requireStaff()
  const parsed = WarrantyItemInput.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Invalid warranty item: ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, project_id, ...fields } = parsed.data
  const update: TablesUpdate<"schedule_items"> = {}
  if (fields.title !== undefined) update.title = fields.title
  if (fields.warranty_date_noted !== undefined)
    update.warranty_date_noted = fields.warranty_date_noted
  if (fields.warranty_resolution !== undefined)
    update.warranty_resolution = fields.warranty_resolution
  if (fields.due_date !== undefined) update.due_date = fields.due_date
  if (fields.status !== undefined) update.status = fields.status
  if (Object.keys(update).length === 0) return

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .update(update)
    .eq("id", id)
    .eq("project_id", project_id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

// Adds a new warranty issue row (a to-do) to a home. The grid renders an empty
// editable row immediately after.
const CreateWarrantyItemInput = z.object({
  project_id: z.string().min(1),
  title: z.string().trim().max(500).optional(),
})

export async function createWarrantyItem(
  input: z.input<typeof CreateWarrantyItemInput>
) {
  const profile = await requireStaff()
  const parsed = CreateWarrantyItemInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("schedule_items")
    .insert({
      project_id: parsed.project_id,
      kind: "todo",
      title: parsed.title?.trim() || "New warranty item",
      status: "not_started",
      created_by: profile.id,
    })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
  return { id: data.id as string }
}

const DeleteWarrantyItemInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
})

export async function deleteWarrantyItem(
  input: z.input<typeof DeleteWarrantyItemInput>
) {
  await requireStaff()
  const parsed = DeleteWarrantyItemInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .delete()
    .eq("id", parsed.id)
    .eq("project_id", parsed.project_id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

// ---------------------------------------------------------------------------
// "Who is Fixing It" — single company assignment
// ---------------------------------------------------------------------------

// The worksheet's "Who is Fixing It" is always a vendor/sub, so we model it as a
// single company assignment. We only ever touch *company* rows for the item —
// any internal-profile assignments made elsewhere are left untouched.
const SetWarrantyAssigneeInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  company_id: z.string().uuid().nullable(),
})

export async function setWarrantyAssignee(
  input: z.input<typeof SetWarrantyAssigneeInput>
) {
  await requireStaff()
  const parsed = SetWarrantyAssigneeInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Verify the item belongs to the project (RLS also gates this, but scoping
  // makes the write explicit and avoids cross-project assignment).
  const { data: item, error: itemErr } = await supabase
    .from("schedule_items")
    .select("id")
    .eq("id", parsed.id)
    .eq("project_id", parsed.project_id)
    .maybeSingle()
  if (itemErr) throw new Error(itemErr.message)
  if (!item) throw new Error("Warranty item not found")

  // Replace the existing company assignment(s) for this item.
  const { error: delErr } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("schedule_item_id", parsed.id)
    .not("company_id", "is", null)
  if (delErr) throw new Error(delErr.message)

  if (parsed.company_id) {
    const { error: insErr } = await supabase
      .from("schedule_assignments")
      .insert({
        schedule_item_id: parsed.id,
        company_id: parsed.company_id,
        profile_id: null,
      })
    if (insErr) throw new Error(insErr.message)
  }
  revalidatePath("/warranty")
}

// ---------------------------------------------------------------------------
// Per-home (project) edits
// ---------------------------------------------------------------------------

const WarrantyEndInput = z.object({
  project_id: z.string().min(1),
  warranty_end_date: nullableDate,
})

export async function updateProjectWarrantyEnd(
  input: z.input<typeof WarrantyEndInput>
) {
  await requireStaff()
  const parsed = WarrantyEndInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("projects")
    .update({ warranty_end_date: parsed.warranty_end_date ?? null })
    .eq("id", parsed.project_id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}
