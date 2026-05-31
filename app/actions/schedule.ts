"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff, requireSession } from "@/lib/auth"
import {
  wouldCreateCycle,
  cascadeFromPredecessors,
  recomputeAnchoredDueDate,
} from "@/lib/schedule/scheduling"
import type { RecurrenceRule } from "@/lib/schedule/recurrence"
import { sendEmail, appUrl } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"

// Permissive schema: accept anything reasonable and normalize inside the
// action. Never let a benign client quirk (null vs "", missing key, extra
// field, etc.) block a save.
const optStr = z.string().nullish() // string | null | undefined

const Recurrence = z
  .object({
    freq: z.enum(["daily", "weekly", "biweekly", "monthly"]),
    interval: z.number().int().positive().optional(),
    until: z.string().optional(),
    count: z.number().int().positive().optional(),
  })
  .nullable()
  .optional()

const Assignment = z.object({
  profile_id: optStr,
  company_id: optStr,
})

const ChecklistItem = z.object({
  id: optStr,
  label: z.string().default(""),
  is_done: z.boolean().default(false),
})

const Predecessor = z.object({
  predecessor_id: z.string(),
  dep_type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
  lag_days: z.coerce.number().int().default(0),
})

const ScheduleItemInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    parent_id: optStr,
    kind: z.enum(["work", "todo"]),
    title: z.string().min(1, "Required").max(300),
    description: optStr,
    start_date: optStr,
    end_date: optStr,
    due_date: optStr,
    // When set, the to-do's due_date is recomputed from the parent's
    // anchor date + offset on every save and on every parent move. Both
    // fields must be present together; the action drops them when the
    // item is a work item or has no parent.
    parent_anchor: z.enum(["start", "end"]).nullish(),
    parent_offset_days: z.coerce.number().int().nullish(),
    status: z
      .enum(["not_started", "in_progress", "complete", "delayed"])
      .default("not_started"),
    priority: z.enum(["low", "medium", "high"]).nullish(),
    recurrence_rule: Recurrence,
    assignments: z.array(Assignment).default([]),
    checklist: z.array(ChecklistItem).default([]),
    predecessors: z.array(Predecessor).default([]),
  })
  // Don't fail on unknown extra fields.
  .passthrough()

export type ScheduleItemInputT = z.infer<typeof ScheduleItemInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

function daysBetween(a: string, b: string) {
  return (
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
  )
}

export async function saveScheduleItem(input: ScheduleItemInputT) {
  const profile = await requireStaff()
  const result = ScheduleItemInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  // Enforce assignment XOR: exactly one of profile_id / company_id per row.
  // Rows where neither is set are dropped silently (user added a row then
  // didn't pick a value). Rows where both are set are a programming error.
  const cleanedAssignments = parsed.assignments
    .map((a) => ({
      profile_id: nz(a.profile_id),
      company_id: nz(a.company_id),
    }))
    .filter((a) => a.profile_id || a.company_id)
  for (const a of cleanedAssignments) {
    if (a.profile_id && a.company_id) {
      throw new Error(
        "An assignment must reference exactly one of profile or company, not both."
      )
    }
  }

  const startD = nz(parsed.start_date)
  const endD = nz(parsed.end_date)
  const duration = startD && endD ? daysBetween(startD, endD) : null

  // Resolve anchor fields. Only valid for todos with a parent — strip them
  // otherwise so we never violate the DB check constraint. When anchored,
  // due_date is recomputed from the parent and any manual `due_date` value
  // the form sent is ignored.
  const parentIdResolved = nz(parsed.parent_id)
  const anchor =
    parsed.kind === "todo" && parentIdResolved && parsed.parent_anchor
      ? parsed.parent_anchor
      : null
  const offset =
    anchor && parsed.parent_offset_days != null
      ? Math.trunc(parsed.parent_offset_days)
      : null
  // Both fields must be set together to satisfy the pair check constraint.
  const anchorFinal = anchor && offset !== null ? anchor : null
  const offsetFinal = anchorFinal !== null ? offset : null

  let computedDueDate: string | null = nz(parsed.due_date)
  if (parsed.kind === "todo" && anchorFinal && parentIdResolved) {
    // Scope by project + require the parent to be a work item. Two reasons:
    // (a) defense in depth against a forged parent_id from another project,
    // (b) RLS already restricts cross-project reads, but the kind filter
    // catches an accidental to-do→to-do anchor that the DB check constraint
    // doesn't (parent_id FK doesn't restrict kind).
    const { data: parentRow, error: parentErr } = await supabase
      .from("schedule_items")
      .select("start_date, end_date")
      .eq("id", parentIdResolved)
      .eq("project_id", parsed.project_id)
      .eq("kind", "work")
      .maybeSingle()
    if (parentErr) throw new Error(parentErr.message)
    if (!parentRow) {
      throw new Error(
        "Selected parent work item was not found in this project."
      )
    }
    computedDueDate = recomputeAnchoredDueDate(
      parentRow,
      anchorFinal,
      offsetFinal ?? 0
    )
  }

  // baseRow is the column set both branches share. created_by is excluded
  // here — adding it to the update path would silently overwrite the
  // original author on every edit (CodeRabbit #29). It's added only to
  // the insert payload below.
  const baseRow = {
    project_id: parsed.project_id,
    parent_id: parentIdResolved,
    kind: parsed.kind,
    title: parsed.title,
    description: nz(parsed.description),
    start_date: startD,
    end_date: endD,
    due_date: computedDueDate,
    duration_days: duration,
    status: parsed.status,
    priority: parsed.priority ?? null,
    recurrence_rule: (parsed.recurrence_rule ?? null) as RecurrenceRule | null,
    parent_anchor: anchorFinal,
    parent_offset_days: offsetFinal,
  }

  let id: string | null = nz(parsed.id)
  if (id) {
    const { error } = await supabase
      .from("schedule_items")
      .update(baseRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({ ...baseRow, created_by: profile.id })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  // Replace assignments. Track who is newly assigned so we can notify.
  const { data: oldAssignments } = await supabase
    .from("schedule_assignments")
    .select("profile_id, company_id")
    .eq("schedule_item_id", id)
  const { error: aDelErr } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("schedule_item_id", id)
  if (aDelErr) throw new Error(aDelErr.message)

  if (cleanedAssignments.length) {
    const rows = cleanedAssignments.map((a) => ({
      schedule_item_id: id!,
      profile_id: a.profile_id,
      company_id: a.company_id,
    }))
    const { error: assignErr } = await supabase
      .from("schedule_assignments")
      .insert(rows)
    if (assignErr) throw new Error(assignErr.message)

    // Notify newly-assigned profiles + companies (idempotent against re-saves).
    // Email + notification failures must NOT fail the primary save — wrap in
    // try/catch and log instead.
    const oldKeys = new Set(
      (oldAssignments ?? []).map(
        (a) => `${a.profile_id ?? ""}|${a.company_id ?? ""}`
      )
    )
    const newOnes = rows.filter(
      (r) => !oldKeys.has(`${r.profile_id ?? ""}|${r.company_id ?? ""}`)
    )
    if (newOnes.length) {
      try {
        await notifyScheduleAssignees(
          newOnes,
          parsed.project_id,
          id!,
          parsed.title
        )
      } catch (e) {
        console.warn(
          "[saveScheduleItem] notifyScheduleAssignees failed (non-fatal):",
          e instanceof Error ? e.message : e
        )
      }
    }
  }

  // Replace checklist (for todos only).
  const { error: clDelErr } = await supabase
    .from("todo_checklist_items")
    .delete()
    .eq("schedule_item_id", id)
  if (clDelErr) throw new Error(clDelErr.message)
  if (parsed.kind === "todo" && parsed.checklist.length) {
    const rows = parsed.checklist
      .filter((c) => c.label.trim() !== "")
      .map((c, i) => ({
        schedule_item_id: id!,
        label: c.label,
        is_done: c.is_done,
        position: i,
      }))
    if (rows.length) {
      const { error: chErr } = await supabase
        .from("todo_checklist_items")
        .insert(rows)
      if (chErr) throw new Error(chErr.message)
    }
  }

  // Replace predecessors with cycle check.
  {
    const { data: existing, error: pSelErr } = await supabase
      .from("schedule_predecessors")
      .select("item_id, predecessor_id, dep_type, lag_days, id, created_at")
      .or(`item_id.eq.${id},predecessor_id.eq.${id}`)
    if (pSelErr) throw new Error(pSelErr.message)
    const allPreds = existing ?? []
    const others = allPreds.filter((p) => p.item_id !== id)
    const proposed = [
      ...others,
      ...parsed.predecessors.map((p) => ({
        id: "new",
        item_id: id!,
        predecessor_id: p.predecessor_id,
        dep_type: p.dep_type,
        lag_days: p.lag_days,
        created_at: "",
      })),
    ]
    for (const p of parsed.predecessors) {
      if (wouldCreateCycle(proposed, id!, p.predecessor_id)) {
        throw new Error("Predecessor would create a cycle")
      }
    }
    const { error: delPredErr } = await supabase
      .from("schedule_predecessors")
      .delete()
      .eq("item_id", id)
    if (delPredErr) throw new Error(delPredErr.message)
    if (parsed.predecessors.length) {
      const rows = parsed.predecessors.map((p) => ({
        item_id: id!,
        predecessor_id: p.predecessor_id,
        dep_type: p.dep_type,
        lag_days: p.lag_days,
      }))
      const { error: predErr } = await supabase
        .from("schedule_predecessors")
        .insert(rows)
      if (predErr) throw new Error(predErr.message)
    }
  }

  const movedIds = await applyCascade(parsed.project_id, id!)
  // When a work item's dates change, every anchored to-do under it has to
  // recompute. Same for successors the predecessor cascade just moved.
  await applyAnchoredChildrenCascade(movedIds)

  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { id }
}

async function notifyScheduleAssignees(
  rows: { profile_id: string | null; company_id: string | null }[],
  projectId: string,
  scheduleItemId: string,
  title: string
) {
  const supabase = await createSupabaseServerClient()
  const profileIds = rows.map((r) => r.profile_id).filter(Boolean) as string[]
  const companyIds = rows.map((r) => r.company_id).filter(Boolean) as string[]

  // In-app notifications for profile assignees
  if (profileIds.length) {
    await supabase.from("notifications").insert(
      profileIds.map((id) => ({
        recipient_id: id,
        type: "schedule_assignment",
        title: `Assigned: ${title}`,
        body: "You were assigned to a schedule item",
        link_url: `/projects/${projectId}/schedule`,
      }))
    )
  }

  // Email + SMS — best-effort, never blocks save. We collect the email and
  // phone-bearing companies in one pass, then fan out in parallel so a slow
  // Quo/Resend doesn't compound onto the schedule save latency.
  try {
    const link = appUrl(`/projects/${projectId}/schedule`)
    const emails: string[] = []
    const phones: string[] = []
    if (profileIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("email")
        .in("id", profileIds)
      for (const p of profs ?? []) if (p.email) emails.push(p.email)
    }
    if (companyIds.length) {
      const { data: cos } = await supabase
        .from("companies")
        .select("name, email, phone")
        .in("id", companyIds)
      for (const c of cos ?? []) {
        if (c.email) emails.push(c.email)
        if (c.phone) {
          const e164 = normalizeE164(c.phone)
          if (e164) phones.push(e164)
        }
      }
    }

    const sends: Promise<unknown>[] = []
    if (emails.length) {
      sends.push(
        sendEmail({
          to: emails,
          subject: `New assignment: ${title}`,
          text: `You were assigned to "${title}" on the project. Open: ${link}`,
        }).catch((e) => console.warn("assignment email failed:", e))
      )
    }
    // SMS goes only to sub/vendor companies (profiles get email + in-app).
    // Message is intentionally terse — texts charge per segment and busy
    // subs scan, not read.
    if (phones.length) {
      const smsBody = `Hines Homes: you were assigned to "${title}". Details: ${link}`
      for (const to of phones) {
        sends.push(
          sendQuoSms({ to, content: smsBody }).then((r) => {
            if (!r.sent) {
              console.warn(
                `assignment SMS to ${to} failed: ${r.reason ?? "unknown"}`
              )
            }
          })
        )
      }
    }
    await Promise.allSettled(sends)
  } catch (e) {
    console.warn("schedule assignment notify failed:", e)
  }
  void scheduleItemId
}

/**
 * Runs the predecessor cascade. Returns the set of item IDs whose dates may
 * have changed (the seed `movedId` plus every successor the cascade touched)
 * so the caller can run dependent cascades — e.g. anchored to-do children —
 * against the same set.
 */
async function applyCascade(
  projectId: string,
  movedId: string
): Promise<string[]> {
  const supabase = await createSupabaseServerClient()
  const { data: items } = await supabase
    .from("schedule_items")
    .select("*")
    .eq("project_id", projectId)
  const { data: preds } = await supabase
    .from("schedule_predecessors")
    .select("*")
  if (!items || !preds) return [movedId]
  const updates = cascadeFromPredecessors(items, preds, movedId)
  for (const u of updates) {
    const { error } = await supabase
      .from("schedule_items")
      .update({ start_date: u.start_date, end_date: u.end_date })
      .eq("id", u.id)
    if (error) {
      // Cascade failed partway. Surface so the caller can investigate; the
      // earlier updates have already persisted (no transaction is available
      // via the JS client).
      throw new Error(
        `Cascade failed at ${u.id}: ${error.message}. Some successor dates may be partially updated.`
      )
    }
  }
  return [movedId, ...updates.map((u) => u.id)]
}

/**
 * For every anchored to-do whose parent appears in `parentIds`, recompute
 * its due_date from the parent's (now-current) start/end + offset. Cheap:
 * one SELECT for the parents, one SELECT for the children, one UPDATE per
 * affected child. Called after applyCascade so we see the post-cascade
 * parent dates.
 */
async function applyAnchoredChildrenCascade(parentIds: string[]) {
  if (parentIds.length === 0) return
  const supabase = await createSupabaseServerClient()
  const { data: parents, error: pErr } = await supabase
    .from("schedule_items")
    .select("id, start_date, end_date")
    .in("id", parentIds)
  if (pErr) throw new Error(pErr.message)
  if (!parents?.length) return
  const { data: children, error: cErr } = await supabase
    .from("schedule_items")
    .select("id, parent_id, parent_anchor, parent_offset_days")
    .in("parent_id", parentIds)
    .not("parent_anchor", "is", null)
  if (cErr) throw new Error(cErr.message)
  for (const c of children ?? []) {
    const p = parents.find((x) => x.id === c.parent_id)
    if (!p || !c.parent_anchor || c.parent_offset_days == null) continue
    const newDue = recomputeAnchoredDueDate(
      p,
      c.parent_anchor,
      c.parent_offset_days
    )
    const { error: uErr } = await supabase
      .from("schedule_items")
      .update({ due_date: newDue })
      .eq("id", c.id)
    if (uErr) {
      throw new Error(
        `Anchored cascade failed at ${c.id}: ${uErr.message}.`
      )
    }
  }
}

const IdProjectInput = z.object({ id: z.string(), project_id: z.string() })

const ReassignInput = z.object({
  id: z.string(),
  project_id: z.string(),
  // For each successor that currently depends on the to-be-deleted item:
  // either point it at a different predecessor (replace) or drop the
  // dependency (remove). Successors not listed default to "remove" — the
  // foreign key would cascade anyway, but listing them gives the UI a
  // chance to surface the change.
  reassignments: z
    .array(
      z.object({
        successor_id: z.string(),
        new_predecessor_id: z.string().nullable(),
        dep_type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
        lag_days: z.coerce.number().int().default(0),
      })
    )
    .default([]),
})

export type SchedulePredecessorDependent = {
  successor_id: string
  successor_title: string
  dep_type: "FS" | "SS" | "FF" | "SF"
  lag_days: number
}

/**
 * Lists schedule items that depend on `id` via a schedule_predecessors row.
 * The UI uses this to drive the reassign-or-remove dialog before deleting
 * a work item that's a predecessor.
 */
export async function getPredecessorDependents(input: {
  id: string
  project_id: string
}): Promise<SchedulePredecessorDependent[]> {
  await requireStaff()
  const parsed = IdProjectInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("schedule_predecessors")
    .select(
      "item_id, dep_type, lag_days, schedule_items!schedule_predecessors_item_id_fkey(id, title, project_id)"
    )
    .eq("predecessor_id", parsed.id)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as Array<{
    item_id: string
    dep_type: "FS" | "SS" | "FF" | "SF"
    lag_days: number
    schedule_items: { id: string; title: string; project_id: string } | null
  }>
  return rows
    .filter((r) => r.schedule_items && r.schedule_items.project_id === parsed.project_id)
    .map((r) => ({
      successor_id: r.item_id,
      successor_title: r.schedule_items!.title,
      dep_type: r.dep_type,
      lag_days: r.lag_days,
    }))
}

export async function deleteScheduleItem(input: {
  id: string
  project_id: string
  reassignments?: Array<{
    successor_id: string
    new_predecessor_id: string | null
    dep_type?: "FS" | "SS" | "FF" | "SF"
    lag_days?: number
  }>
}) {
  await requireStaff()
  const parsed = ReassignInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Apply reassignments before the delete so we can validate the new
  // predecessor exists and doesn't introduce a cycle. Each reassignment
  // first removes the existing edge that pointed at the doomed item, then
  // inserts a fresh edge (when new_predecessor_id is non-null).
  for (const r of parsed.reassignments) {
    const { error: delEdgeErr } = await supabase
      .from("schedule_predecessors")
      .delete()
      .eq("item_id", r.successor_id)
      .eq("predecessor_id", parsed.id)
    if (delEdgeErr) throw new Error(delEdgeErr.message)

    if (r.new_predecessor_id) {
      // Cycle check against the current graph.
      const { data: existing, error: pErr } = await supabase
        .from("schedule_predecessors")
        .select("id, item_id, predecessor_id, dep_type, lag_days, created_at")
      if (pErr) throw new Error(pErr.message)
      const proposed = [
        ...(existing ?? []),
        {
          id: "new",
          item_id: r.successor_id,
          predecessor_id: r.new_predecessor_id,
          dep_type: r.dep_type,
          lag_days: r.lag_days,
          created_at: "",
        },
      ]
      if (
        wouldCreateCycle(proposed, r.successor_id, r.new_predecessor_id)
      ) {
        throw new Error(
          `New predecessor for "${r.successor_id}" would create a cycle.`
        )
      }
      const { error: insErr } = await supabase
        .from("schedule_predecessors")
        .insert({
          item_id: r.successor_id,
          predecessor_id: r.new_predecessor_id,
          dep_type: r.dep_type,
          lag_days: r.lag_days,
        })
      if (insErr) throw new Error(insErr.message)
    }
  }

  const { error } = await supabase
    .from("schedule_items")
    .delete()
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
}

export async function logDelay({
  schedule_item_id,
  project_id,
  delay_days,
  reason_category,
  notes,
  push_dates,
}: {
  schedule_item_id: string
  project_id: string
  delay_days: number
  reason_category: "weather" | "sub" | "material" | "owner_decision" | "permit" | "other"
  notes?: string
  push_dates?: boolean
}) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("schedule_delays").insert({
    schedule_item_id,
    delay_days,
    reason_category,
    notes: notes ?? null,
    logged_by: profile.id,
  })
  if (error) throw new Error(error.message)
  if (push_dates && delay_days > 0) {
    const { data: item } = await supabase
      .from("schedule_items")
      .select("start_date, end_date, due_date")
      .eq("id", schedule_item_id)
      .maybeSingle()
    if (item) {
      const shift = (d: string | null) =>
        d ? new Date(new Date(d).getTime() + delay_days * 86400000).toISOString().slice(0, 10) : null
      await supabase
        .from("schedule_items")
        .update({
          start_date: shift(item.start_date),
          end_date: shift(item.end_date),
          due_date: shift(item.due_date),
          status: "delayed",
        })
        .eq("id", schedule_item_id)
      const movedIds = await applyCascade(project_id, schedule_item_id)
      await applyAnchoredChildrenCascade(movedIds)
    }
  }
  revalidatePath(`/projects/${project_id}/schedule`)
}

const MoveInput = z.object({
  id: z.string(),
  project_id: z.string(),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
})

export async function moveScheduleItem(input: {
  id: string
  project_id: string
  start_date: string
  end_date: string
}) {
  await requireStaff()
  const parsed = MoveInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .update({ start_date: parsed.start_date, end_date: parsed.end_date })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  const movedIds = await applyCascade(parsed.project_id, parsed.id)
  await applyAnchoredChildrenCascade(movedIds)
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
}

export async function setItemStatus({
  id,
  project_id,
  status,
}: {
  id: string
  project_id: string
  status: "not_started" | "in_progress" | "complete" | "delayed"
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .update({ status })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/schedule`)
}

const SendSubTextInput = z.object({
  schedule_item_id: z.string(),
  company_id: z.string(),
  message: z.string().min(1).max(1600),
})

export type SendQuoTextResult =
  | { ok: true; to: string; company_name: string }
  | { ok: false; error: string }

/**
 * Sends an SMS via Quo to a subcontractor company that's assigned to the
 * given schedule item. Verifies the assignment server-side (defense in
 * depth — the client picks the recipient, but we never trust that on its
 * own) and that the company actually has a phone number on file.
 *
 * Returns a typed result instead of throwing on user-facing failures
 * (missing assignment, missing phone, Quo API error) — Next.js masks
 * thrown error messages in production builds, so throwing would leave
 * the user with the generic "Server Components render" toast instead of
 * a useful reason. Genuine programming errors (e.g. an unexpected
 * Supabase exception) still propagate.
 */
export async function sendQuoTextToSub(input: {
  schedule_item_id: string
  company_id: string
  message: string
}): Promise<SendQuoTextResult> {
  await requireStaff()
  const parsed = SendSubTextInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Verify the company is actually assigned to this schedule item.
  const { data: assignment, error: aErr } = await supabase
    .from("schedule_assignments")
    .select("id")
    .eq("schedule_item_id", parsed.schedule_item_id)
    .eq("company_id", parsed.company_id)
    .maybeSingle()
  if (aErr) {
    console.error("[sendQuoTextToSub] assignment lookup failed:", aErr)
    return { ok: false, error: "Couldn't verify the assignment. Try again." }
  }
  if (!assignment) {
    return {
      ok: false,
      error:
        "That sub isn't saved on this schedule item yet. Click Save first, then send.",
    }
  }

  const { data: company, error: cErr } = await supabase
    .from("companies")
    .select("name, phone")
    .eq("id", parsed.company_id)
    .maybeSingle()
  if (cErr) {
    console.error("[sendQuoTextToSub] company lookup failed:", cErr)
    return { ok: false, error: "Couldn't load the company. Try again." }
  }
  if (!company) return { ok: false, error: "Company not found." }
  if (!company.phone) {
    return { ok: false, error: `${company.name} has no phone number on file.` }
  }
  const normalized = normalizeE164(company.phone)
  if (!normalized) {
    return {
      ok: false,
      error: `${company.name}'s phone number (${company.phone}) isn't a valid US number.`,
    }
  }

  const result = await sendQuoSms({ to: normalized, content: parsed.message })
  if (!result.sent) {
    return { ok: false, error: result.reason ?? "Failed to send text." }
  }
  return { ok: true, to: normalized, company_name: company.name }
}

const AttachmentInput = z.object({
  schedule_item_id: z.string(),
  project_id: z.string(),
  storage_path: z.string().min(1),
  file_name: z.string().min(1).max(500),
  file_type: z.string().max(200).nullish(),
  file_size: z.coerce.number().int().nullish(),
  caption: z.string().max(500).nullish(),
})

/**
 * Records an upload that already landed in Storage. The browser performs the
 * actual PUT against `project-files` using its own session JWT (RLS gate),
 * then calls this action with the resulting storage_path so we can attach it
 * to the schedule item.
 */
export async function addScheduleItemAttachment(input: {
  schedule_item_id: string
  project_id: string
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
  caption?: string | null
}) {
  const profile = await requireStaff()
  const parsed = AttachmentInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Defence in depth: confirm the schedule item exists in the named project.
  // A malicious client could otherwise attach a file to an item in a
  // different project they happen to own.
  const { data: item, error: itemErr } = await supabase
    .from("schedule_items")
    .select("id, project_id")
    .eq("id", parsed.schedule_item_id)
    .maybeSingle()
  if (itemErr) throw new Error(itemErr.message)
  if (!item || item.project_id !== parsed.project_id) {
    throw new Error("Schedule item not found in this project.")
  }

  const { data, error } = await supabase
    .from("schedule_item_attachments")
    .insert({
      schedule_item_id: parsed.schedule_item_id,
      storage_path: parsed.storage_path,
      file_name: parsed.file_name,
      file_type: nz(parsed.file_type ?? null),
      file_size: parsed.file_size ?? null,
      caption: nz(parsed.caption ?? null),
      uploaded_by: profile.id,
    })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { id: data.id }
}

export async function deleteScheduleItemAttachment(input: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const parsed = z.object({ id: z.string(), project_id: z.string() }).parse(input)
  const supabase = await createSupabaseServerClient()

  // Look up the storage_path AND verify the attachment belongs to the named
  // project. Without the project check, a forged (or simply wrong) id could
  // delete an attachment from a different project. The inner join also gives
  // us the storage_path needed to purge the file from the bucket.
  const { data: existing, error: existingErr } = await supabase
    .from("schedule_item_attachments")
    .select("storage_path, schedule_items!inner(project_id)")
    .eq("id", parsed.id)
    .maybeSingle()
  if (existingErr) throw new Error(existingErr.message)
  if (!existing) throw new Error("Attachment not found.")
  const owningProject = (
    existing as unknown as { schedule_items: { project_id: string } }
  ).schedule_items.project_id
  if (owningProject !== parsed.project_id) {
    throw new Error("Attachment does not belong to this project.")
  }
  const { error } = await supabase
    .from("schedule_item_attachments")
    .delete()
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  if (existing?.storage_path) {
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove([existing.storage_path])
    if (storageErr) {
      console.warn(
        "[deleteScheduleItemAttachment] storage cleanup failed:",
        storageErr.message
      )
    }
  }
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
}

export async function getScheduleAttachmentSignedUrls(paths: string[]) {
  if (paths.length === 0) return {}
  await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage
    .from("project-files")
    .createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}

export async function toggleChecklistItem({
  id,
  project_id,
  is_done,
}: {
  id: string
  project_id: string
  is_done: boolean
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("todo_checklist_items")
    .update({ is_done })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/schedule`)
}

// ============================================================================
// Bulk operations
// ============================================================================
//
// The schedule UI lets a PM pick N items via checkboxes and apply a single
// action (shift dates, change status, delete). Each action lives behind its
// own server function because they have different validation rules and
// different cascade behaviour. They all share these traits:
//
//  - Scoped to a single project_id so RLS catches cross-project leakage.
//  - Cap at 500 ids per call so a runaway "select all" can't lock the table.
//  - Return a typed result with successes / failures rather than throwing,
//    so the UI can surface partial-failure detail (e.g. "12 shifted, 3 had
//    cycle conflicts").
//
// Cascade behaviour matches the single-item path: predecessor cascade +
// anchored-child cascade run after every bulk move so successor dates stay
// consistent.

const BulkIdsInput = z.object({
  project_id: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
})

const BulkStatusInput = BulkIdsInput.extend({
  status: z.enum(["not_started", "in_progress", "complete", "delayed"]),
})

const BulkShiftInput = BulkIdsInput.extend({
  // ±N days. Cap at ±365 so a fat-finger doesn't push the schedule into
  // year-2099 territory.
  days: z.coerce.number().int().min(-365).max(365),
})

export type BulkScheduleResult = {
  ok: number
  skipped: { id: string; reason: string }[]
}

export async function bulkSetScheduleStatus(input: {
  project_id: string
  ids: string[]
  status: "not_started" | "in_progress" | "complete" | "delayed"
}): Promise<BulkScheduleResult> {
  await requireStaff()
  const parsed = BulkStatusInput.parse(input)
  const supabase = await createSupabaseServerClient()
  // Single batched UPDATE — RLS will silently drop rows the user can't write,
  // so we compare returned-vs-requested to detect that case.
  const { data, error } = await supabase
    .from("schedule_items")
    .update({ status: parsed.status })
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
    .select("id")
  if (error) throw new Error(error.message)
  const updated = new Set((data ?? []).map((r) => r.id))
  const skipped = parsed.ids
    .filter((id) => !updated.has(id))
    .map((id) => ({ id, reason: "not found in project (or RLS denied)" }))
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: updated.size, skipped }
}

export async function bulkShiftScheduleDates(input: {
  project_id: string
  ids: string[]
  days: number
}): Promise<BulkScheduleResult> {
  await requireStaff()
  const parsed = BulkShiftInput.parse(input)
  if (parsed.days === 0) {
    return { ok: 0, skipped: parsed.ids.map((id) => ({ id, reason: "zero days" })) }
  }
  const supabase = await createSupabaseServerClient()
  const { data: items, error: selErr } = await supabase
    .from("schedule_items")
    .select("id, start_date, end_date, due_date")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
  if (selErr) throw new Error(selErr.message)

  const skipped: { id: string; reason: string }[] = []
  const movedIds: string[] = []
  const shift = (d: string | null) =>
    d
      ? new Date(new Date(d).getTime() + parsed.days * 86400000)
          .toISOString()
          .slice(0, 10)
      : null

  // Per-row UPDATE because each row's new dates depend on its existing dates;
  // a single SQL CASE would work too but is harder to reason about under RLS.
  for (const item of items ?? []) {
    const hasAny = item.start_date || item.end_date || item.due_date
    if (!hasAny) {
      skipped.push({ id: item.id, reason: "no dates to shift" })
      continue
    }
    const { error: uErr } = await supabase
      .from("schedule_items")
      .update({
        start_date: shift(item.start_date),
        end_date: shift(item.end_date),
        due_date: shift(item.due_date),
      })
      .eq("id", item.id)
    if (uErr) {
      skipped.push({ id: item.id, reason: uErr.message })
      continue
    }
    movedIds.push(item.id)
  }

  // Cascade from each moved item. Running one global cascade per move is
  // O(items × cascade) but the cascade itself is O(graph) and graphs are
  // small per project. For 500 moves on a 200-item project we're still in
  // the sub-second range. If this becomes a bottleneck, batch cascades by
  // dependency depth and dedupe traversal.
  const cascadeMoved = new Set<string>(movedIds)
  for (const id of movedIds) {
    const more = await applyCascade(parsed.project_id, id)
    for (const m of more) cascadeMoved.add(m)
  }
  await applyAnchoredChildrenCascade(Array.from(cascadeMoved))

  // For any IDs that weren't returned by the SELECT (RLS / wrong project),
  // record them as skipped too.
  const seen = new Set((items ?? []).map((i) => i.id))
  for (const id of parsed.ids) {
    if (!seen.has(id))
      skipped.push({ id, reason: "not found in project (or RLS denied)" })
  }
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: movedIds.length, skipped }
}

export async function bulkDeleteScheduleItems(input: {
  project_id: string
  ids: string[]
}): Promise<BulkScheduleResult> {
  await requireStaff()
  const parsed = BulkIdsInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Defensive: refuse if any selected item is a predecessor of an item that
  // ISN'T also being deleted. Otherwise the FK cascade silently drops the
  // dependency and the surviving successor's schedule shifts unexpectedly.
  // For an explicit reassignment flow, the single-item deleteScheduleItem
  // already exists — point staff there.
  const idSet = new Set(parsed.ids)
  const { data: preds, error: pErr } = await supabase
    .from("schedule_predecessors")
    .select("item_id, predecessor_id")
    .in("predecessor_id", parsed.ids)
  if (pErr) throw new Error(pErr.message)
  const externalDependencies = (preds ?? []).filter(
    (p) => !idSet.has(p.item_id)
  )
  if (externalDependencies.length > 0) {
    // Report all blocking ids in the skip list so the UI can highlight them.
    const blockingIds = new Set(
      externalDependencies.map((p) => p.predecessor_id)
    )
    const skipped = Array.from(blockingIds).map((id) => ({
      id,
      reason:
        "is a predecessor of an item not in the selection — delete individually with reassignment",
    }))
    return { ok: 0, skipped }
  }

  const { data, error } = await supabase
    .from("schedule_items")
    .delete()
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
    .select("id")
  if (error) throw new Error(error.message)
  const deleted = new Set((data ?? []).map((r) => r.id))
  const skipped = parsed.ids
    .filter((id) => !deleted.has(id))
    .map((id) => ({ id, reason: "not found in project (or RLS denied)" }))
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: deleted.size, skipped }
}
