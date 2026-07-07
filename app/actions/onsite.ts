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
import { rollRecurringTodo } from "@/lib/schedule/roll-recurrence"

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")

// z.guid() — UUID-shape check that's compatible with this DB's UUIDs
// (z.uuid() in zod v4 rejects some valid Postgres UUIDs).
const ScheduleItemId = z.guid()
const ProjectId = z.guid()

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
 * Answers a "will this complete on time?" / "when did this finish?" prompt.
 * Works for both work items (which use end_date) and to-dos (which use
 * due_date) — the action looks up the row's kind and writes the right
 * column. Three answer shapes:
 *
 * - yes_today      → mark complete; snap the relevant date to today only if
 *                    it had drifted past (avoids inflating duration on items
 *                    that are simply hitting their planned date).
 * - already_done   → mark complete with the user-supplied actual date.
 * - new_end_date   → keep working; push the date out. For work items this
 *                    also runs the predecessor cascade so successors move.
 *                    To-dos don't drive the cascade.
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
    .select("id, kind, start_date, end_date, due_date, status")
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!item) return { ok: false, error: "Schedule item not found." }

  const isTodo = item.kind === "todo"
  const currentDate = isTodo ? item.due_date : item.end_date
  let newDate: string | null = currentDate
  let newStatus: "in_progress" | "complete" = "complete"

  if (data.answer === "yes_today") {
    const today = todayISO()
    if (currentDate && currentDate < today) newDate = today
  } else if (data.answer === "already_done") {
    newDate = data.actual_end_date
  } else {
    newDate = data.new_end_date
    newStatus = "in_progress"
  }

  const dateChanged = newDate !== currentDate
  const update = isTodo
    ? { status: newStatus, due_date: newDate }
    : { status: newStatus, end_date: newDate }
  const { error: updErr } = await supabase
    .from("schedule_items")
    .update(update)
    .eq("id", data.schedule_item_id)
    .eq("project_id", data.project_id)
  if (updErr) return { ok: false, error: updErr.message }

  // Recurring to-do completed: spawn its next occurrence. The update above
  // may have rewritten due_date to the completion date, so anchor the roll to
  // the ORIGINAL due date to keep the series cadence.
  if (isTodo && newStatus === "complete") {
    await rollRecurringTodo(supabase, data.schedule_item_id, {
      anchorDueOverride: item.due_date,
    })
  }

  // Only work items drive the predecessor cascade — to-dos aren't part of
  // the dependency graph.
  if (dateChanged && !isTodo) {
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
