"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import {
  cascadeFromPredecessors,
  recomputeAnchoredDueDate,
} from "@/lib/schedule/scheduling"
import { todayISO } from "@/lib/utils"

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")

const ScheduleItemId = z.string().uuid()
const ProjectId = z.string().uuid()

const CompletionInput = z.discriminatedUnion("answer", [
  z.object({
    schedule_item_id: ScheduleItemId,
    project_id: ProjectId,
    answer: z.literal("yes_today"),
  }),
  z.object({
    schedule_item_id: ScheduleItemId,
    project_id: ProjectId,
    answer: z.literal("already_done"),
    actual_end_date: IsoDate,
  }),
  z.object({
    schedule_item_id: ScheduleItemId,
    project_id: ProjectId,
    answer: z.literal("new_end_date"),
    new_end_date: IsoDate,
  }),
])

const StartInput = z.discriminatedUnion("answer", [
  z.object({
    schedule_item_id: ScheduleItemId,
    project_id: ProjectId,
    answer: z.literal("yes"),
  }),
  z.object({
    schedule_item_id: ScheduleItemId,
    project_id: ProjectId,
    answer: z.literal("new_start_date"),
    new_start_date: IsoDate,
  }),
])

export type OnsiteAnswerResult = { ok: true } | { ok: false; error: string }

/**
 * Answers a "will this complete on time?" / "when did this finish?" prompt
 * for a work item whose end_date has hit or passed. Three shapes:
 *
 * - yes_today      → mark complete; snap end_date to today only if it had
 *                    drifted past (avoids inflating duration on items that
 *                    are simply hitting their planned end_date).
 * - already_done   → mark complete with the user-supplied actual end date.
 * - new_end_date   → keep working; push the end_date out and let the
 *                    predecessor cascade move successors forward.
 *
 * Any date change runs the same cascade the schedule editor uses, so
 * downstream items shift consistently with the rest of the app.
 */
export async function answerCompletion(
  input: z.input<typeof CompletionInput>
): Promise<OnsiteAnswerResult> {
  await requireStaff()
  const parsed = CompletionInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad input" }
  }
  const data = parsed.data
  const supabase = await createSupabaseServerClient()

  // Constrain to BOTH item id and the caller-supplied project id so a
  // mismatched pair can never silently mutate one project while we
  // cascade/revalidate the other. RLS would catch most of this, but
  // defense in depth is cheap.
  const { data: item, error: readErr } = await supabase
    .from("schedule_items")
    .select("id, start_date, end_date, status")
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!item) return { ok: false, error: "Schedule item not found." }

  let newEndDate: string | null = item.end_date
  let newStatus: "in_progress" | "complete" = "complete"

  if (data.answer === "yes_today") {
    const today = todayISO()
    if (item.end_date && item.end_date < today) newEndDate = today
  } else if (data.answer === "already_done") {
    newEndDate = data.actual_end_date
  } else {
    newEndDate = data.new_end_date
    newStatus = "in_progress"
  }

  const dateChanged = newEndDate !== item.end_date
  const { error: updErr } = await supabase
    .from("schedule_items")
    .update({ status: newStatus, end_date: newEndDate })
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
  if (updErr) return { ok: false, error: updErr.message }

  if (dateChanged) {
    const cascadeErr = await runCascade(data.project_id, data.schedule_item_id)
    if (cascadeErr) return { ok: false, error: cascadeErr }
  }

  revalidatePath(`/projects/${data.project_id}/onsite`)
  revalidatePath(`/projects/${data.project_id}/schedule`)
  return { ok: true }
}

/**
 * Answers a "did this start today?" / "when will it start?" prompt for a
 * work item with start_date today or in the next two days.
 *
 * - yes            → flip status to in_progress; leave start_date alone.
 * - new_start_date → shift start_date forward (and preserve duration on the
 *                    end_date), then cascade.
 */
export async function answerStart(
  input: z.input<typeof StartInput>
): Promise<OnsiteAnswerResult> {
  await requireStaff()
  const parsed = StartInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad input" }
  }
  const data = parsed.data
  const supabase = await createSupabaseServerClient()

  if (data.answer === "yes") {
    const { error } = await supabase
      .from("schedule_items")
      .update({ status: "in_progress" })
      .eq("id", data.schedule_item_id)
      .eq("project_id", data.project_id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/projects/${data.project_id}/onsite`)
    revalidatePath(`/projects/${data.project_id}/schedule`)
    return { ok: true }
  }

  const { data: item, error: readErr } = await supabase
    .from("schedule_items")
    .select("id, start_date, end_date")
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!item) return { ok: false, error: "Schedule item not found." }

  // Preserve duration when shifting start.
  let newEnd: string | null = item.end_date
  if (item.start_date && item.end_date) {
    const durationMs =
      new Date(item.end_date).getTime() - new Date(item.start_date).getTime()
    newEnd = new Date(
      new Date(data.new_start_date).getTime() + durationMs
    )
      .toISOString()
      .slice(0, 10)
  }

  const { error: updErr } = await supabase
    .from("schedule_items")
    .update({ start_date: data.new_start_date, end_date: newEnd })
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
  if (updErr) return { ok: false, error: updErr.message }

  const cascadeErr = await runCascade(data.project_id, data.schedule_item_id)
  if (cascadeErr) return { ok: false, error: cascadeErr }

  revalidatePath(`/projects/${data.project_id}/onsite`)
  revalidatePath(`/projects/${data.project_id}/schedule`)
  return { ok: true }
}

// Re-fetches the project's items + predecessors, runs the cascade, and
// applies the resulting successor date shifts plus any anchored-to-do
// recomputations. Mirrors the private helper in app/actions/schedule.ts —
// kept local so this module doesn't reach into another action file.
async function runCascade(
  projectId: string,
  movedId: string
): Promise<string | null> {
  const supabase = await createSupabaseServerClient()
  const { data: items, error: itemsErr } = await supabase
    .from("schedule_items")
    .select("*")
    .eq("project_id", projectId)
  if (itemsErr) return itemsErr.message
  const { data: preds, error: predsErr } = await supabase
    .from("schedule_predecessors")
    .select("*")
  if (predsErr) return predsErr.message
  if (!items || !preds) return null

  const updates = cascadeFromPredecessors(items, preds, movedId)
  const touched = new Set<string>([movedId])
  for (const u of updates) {
    const { error } = await supabase
      .from("schedule_items")
      .update({ start_date: u.start_date, end_date: u.end_date })
      .eq("id", u.id)
    if (error) {
      return `Cascade failed at ${u.id}: ${error.message}`
    }
    touched.add(u.id)
  }

  // Anchored children inherit dates from their parent. Recompute every
  // anchored child whose parent moved.
  const parentIds = Array.from(touched)
  const { data: parents, error: parentsErr } = await supabase
    .from("schedule_items")
    .select("id, start_date, end_date")
    .in("id", parentIds)
  if (parentsErr) return parentsErr.message
  const { data: children, error: childrenErr } = await supabase
    .from("schedule_items")
    .select("id, parent_id, parent_anchor, parent_offset_days")
    .in("parent_id", parentIds)
    .not("parent_anchor", "is", null)
  if (childrenErr) return childrenErr.message

  for (const c of children ?? []) {
    const p = parents?.find((x) => x.id === c.parent_id)
    if (!p || !c.parent_anchor || c.parent_offset_days == null) continue
    const newDue = recomputeAnchoredDueDate(
      p,
      c.parent_anchor,
      c.parent_offset_days
    )
    const { error } = await supabase
      .from("schedule_items")
      .update({ due_date: newDue })
      .eq("id", c.id)
    if (error) return `Anchored cascade failed at ${c.id}: ${error.message}`
  }

  return null
}
