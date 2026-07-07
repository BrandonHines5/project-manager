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
import type { TablesUpdate } from "@/lib/db/types"
import { sendEmail, appUrl } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { notifyCommentPosted } from "@/lib/comms/notify"
import { normalizeTag } from "@/lib/template-tags"

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
  // A role-based assignment (migration 0054). Resolves to a concrete person
  // via the project's role map for display and trade visibility.
  role_id: optStr,
})

const ChecklistItem = z.object({
  id: optStr,
  label: z.string().default(""),
  is_done: z.boolean().default(false),
  // Optional per-item assignee — exactly one of profile/company/role, or
  // none. When set, the assignee is also rolled up onto the parent to-do's
  // assignments so the to-do shows in their queue (see saveScheduleItem).
  assignee_profile_id: optStr,
  assignee_company_id: optStr,
  assignee_role_id: optStr,
})

const Predecessor = z.object({
  predecessor_id: z.string(),
  dep_type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
  lag_days: z.coerce.number().int().default(0),
})

// Why a date move happened. Required (and logged to schedule_delays) whenever
// a work item's dates change after the project baseline is locked; free-form
// moves need no reason while the schedule is still being drafted.
const MoveReason = z.object({
  reason_category: z.enum([
    "weather",
    "sub",
    "material",
    "owner_decision",
    "permit",
    "other",
  ]),
  notes: optStr,
})
export type MoveReasonT = z.infer<typeof MoveReason>

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
    // When true, the item is excluded from the critical-path calculation —
    // for schedule markers (e.g. a completion target) that aren't real
    // on-site work and shouldn't drive the project finish.
    exclude_from_critical_path: z.boolean().default(false),
    recurrence_rule: Recurrence,
    // Smart-template conditions (e.g. ["walkout"]). Optional so callers
    // that don't send the field (bulk ops, copy-to-targets) leave the
    // stored value untouched.
    template_tags: z.array(z.string()).optional(),
    assignments: z.array(Assignment).default([]),
    checklist: z.array(ChecklistItem).default([]),
    predecessors: z.array(Predecessor).default([]),
    // Only consulted when the save moves a work item's dates on a baselined
    // project — the dialog collects it via the move-reason popup.
    move_reason: MoveReason.nullish(),
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

const BASELINE_COMPLETE_MSG =
  "Lock the schedule baseline before marking work items complete — use “Set baseline” at the top of the schedule. (To-dos can be completed anytime.)"
const MOVE_REASON_MSG =
  "This schedule is baselined — date changes on work items need a reason. Retry the move and pick one in the popup."

async function getBaselineSetAt(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  projectId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("baseline_set_at")
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.baseline_set_at ?? null
}

// How many days a move shifted an item, for the schedule_delays log. The end
// date is what "delay" means to the job, so it wins; a pure start move falls
// back to the start shift. Negative = pulled earlier.
function dateShiftDays(
  oldStart: string | null,
  oldEnd: string | null,
  newStart: string | null,
  newEnd: string | null
): number {
  const diff = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
  if (oldEnd && newEnd && oldEnd !== newEnd) return diff(oldEnd, newEnd)
  if (oldStart && newStart && oldStart !== newStart) return diff(oldStart, newStart)
  return 0
}

// Best-effort: the move itself already succeeded, so a failed reason insert
// logs loudly instead of surfacing a confusing error for an applied change.
async function logMoveReasons(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  rows: {
    schedule_item_id: string
    delay_days: number
    reason_category: MoveReasonT["reason_category"]
    notes: string | null
    logged_by: string
  }[]
) {
  if (rows.length === 0) return
  const { error } = await supabase.from("schedule_delays").insert(rows)
  if (error) {
    console.warn("[schedule] move-reason delay log failed:", error.message)
  }
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

  // Baseline state drives two business rules below: work items can't be
  // completed before the baseline is locked, and post-baseline date moves
  // must carry a reason. One cheap row read either way.
  const baselineSetAt = await getBaselineSetAt(supabase, parsed.project_id)

  // On edit, gates compare against the STORED row — the payload's kind/status
  // can't be trusted to describe what's already in the DB.
  const editId = nz(parsed.id)
  let oldRow: {
    kind: "work" | "todo"
    status: string
    start_date: string | null
    end_date: string | null
    milestone: string | null
  } | null = null
  if (editId) {
    const { data: existing, error: exErr } = await supabase
      .from("schedule_items")
      .select("kind, status, start_date, end_date, milestone, project_id")
      .eq("id", editId)
      .maybeSingle()
    if (exErr) throw new Error(exErr.message)
    if (!existing || existing.project_id !== parsed.project_id) {
      throw new Error("Schedule item not found in this project.")
    }
    oldRow = existing
  }

  // Completion gate: the first work item can only be completed once the
  // baseline is set. Only the transition into `complete` is gated so
  // unrelated edits to an already-complete item still save pre-baseline.
  const gateKind = oldRow?.kind ?? parsed.kind
  if (
    parsed.status === "complete" &&
    gateKind === "work" &&
    !baselineSetAt &&
    (oldRow ? oldRow.status !== "complete" : true)
  ) {
    throw new Error(BASELINE_COMPLETE_MSG)
  }

  // Enforce assignment XOR: exactly one of profile_id / company_id / role_id
  // per row. Rows where none is set are dropped silently (user added a row
  // then didn't pick a value). Rows where more than one is set are a
  // programming error.
  const cleanedAssignments = parsed.assignments
    .map((a) => ({
      profile_id: nz(a.profile_id),
      company_id: nz(a.company_id),
      role_id: nz(a.role_id),
    }))
    .filter((a) => a.profile_id || a.company_id || a.role_id)
  for (const a of cleanedAssignments) {
    if (
      Number(!!a.profile_id) + Number(!!a.company_id) + Number(!!a.role_id) >
      1
    ) {
      throw new Error(
        "An assignment must reference exactly one of profile, company, or role."
      )
    }
  }

  // Checklist assignees mirror the assignment shape: exactly one of
  // profile/company/role, or none. Validate before the sole-assignee rule so
  // a malformed row can't sneak through by being overwritten.
  let checklistItems = parsed.checklist
  if (parsed.kind === "todo") {
    for (const c of checklistItems) {
      const set =
        Number(!!nz(c.assignee_profile_id)) +
        Number(!!nz(c.assignee_company_id)) +
        Number(!!nz(c.assignee_role_id))
      if (set > 1) {
        throw new Error(
          "A checklist item assignee must be exactly one of profile, company, or role."
        )
      }
    }
  }

  // Sole-assignee rule: when the to-do itself has exactly one assignee
  // (person, company, or role), every checklist item follows it. The
  // checklist picker only offers the to-do's own assignees anyway, so with
  // one assignee there is nothing else a row could point at — this just
  // keeps rows added through other paths (AI, copy) consistent.
  if (parsed.kind === "todo" && cleanedAssignments.length === 1) {
    const sole = cleanedAssignments[0]
    checklistItems = checklistItems.map((c) => ({
      ...c,
      assignee_profile_id: sole.profile_id,
      assignee_company_id: sole.company_id,
      assignee_role_id: sole.role_id,
    }))
  }

  // Roll checklist-item assignees up onto the to-do's assignments. Assigning
  // someone to a checklist item implicitly makes them responsible for the
  // to-do, so we de-dupe them into the assignment set. Only meaningful for
  // todos (work items don't carry a checklist).
  if (parsed.kind === "todo") {
    const seen = new Set(
      cleanedAssignments.map(
        (a) => `${a.profile_id ?? ""}|${a.company_id ?? ""}|${a.role_id ?? ""}`
      )
    )
    for (const c of checklistItems) {
      const pid = nz(c.assignee_profile_id)
      const cid = nz(c.assignee_company_id)
      const rid = nz(c.assignee_role_id)
      if (!pid && !cid && !rid) continue
      const key = `${pid ?? ""}|${cid ?? ""}|${rid ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      cleanedAssignments.push({
        profile_id: pid,
        company_id: cid,
        role_id: rid,
      })
    }
  }

  // A work item's start/end are both-or-neither at the DB level (check
  // constraint schedule_items_dates_chk: both null, or both set with
  // end >= start). The dialog lets a user enter only a start date — e.g. a
  // single-day marker/milestone (often with exclude_from_critical_path set) —
  // so mirror a lone date onto the missing side. Without this the insert
  // trips the constraint and throws a DB error that Next.js redacts in
  // production to an opaque "Server Components render" message.
  let startD = nz(parsed.start_date)
  let endD = nz(parsed.end_date)
  if (parsed.kind === "work") {
    if (startD && !endD) endD = startD
    else if (endD && !startD) startD = endD
  }
  const duration = startD && endD ? daysBetween(startD, endD) : null

  // Move-reason gate: once the baseline is locked, changing a work item's
  // dates requires a reason (logged to schedule_delays after the save).
  const workDatesChanged =
    oldRow !== null &&
    oldRow.kind === "work" &&
    (oldRow.start_date !== startD || oldRow.end_date !== endD)
  if (workDatesChanged && baselineSetAt && !parsed.move_reason) {
    throw new Error(MOVE_REASON_MSG)
  }

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
    // Only meaningful for work items (CPM ignores to-dos), but storing it
    // unconditionally keeps the column honest if an item's kind ever flips.
    exclude_from_critical_path: parsed.exclude_from_critical_path,
    recurrence_rule: (parsed.recurrence_rule ?? null) as RecurrenceRule | null,
    parent_anchor: anchorFinal,
    parent_offset_days: offsetFinal,
    // Only touch template_tags when the caller sent them — undefined means
    // "not editing tags in this save".
    ...(parsed.template_tags !== undefined
      ? {
          template_tags: parsed.template_tags
            .map(normalizeTag)
            .filter((t, i, arr) => t !== "" && arr.indexOf(t) === i),
        }
      : {}),
  }

  let id: string | null = nz(parsed.id)
  if (id) {
    const { error } = await supabase
      .from("schedule_items")
      .update(baseRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
    if (workDatesChanged && baselineSetAt && parsed.move_reason) {
      await logMoveReasons(supabase, [
        {
          schedule_item_id: id,
          delay_days: dateShiftDays(
            oldRow!.start_date,
            oldRow!.end_date,
            startD,
            endD
          ),
          reason_category: parsed.move_reason.reason_category,
          notes: nz(parsed.move_reason.notes),
          logged_by: profile.id,
        },
      ])
    }
  } else {
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({
        ...baseRow,
        created_by: profile.id,
        // Work items born after the baseline lock get their initial dates as
        // baseline, so added scope shows up in the variance report instead of
        // reading as unplanned free work.
        ...(parsed.kind === "work" && baselineSetAt && startD && endD
          ? { baseline_start_date: startD, baseline_end_date: endD }
          : {}),
      })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  // Replace assignments. Track who is newly assigned so we can notify.
  const { data: oldAssignments } = await supabase
    .from("schedule_assignments")
    .select("profile_id, company_id, role_id")
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
      role_id: a.role_id,
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
        (a) => `${a.profile_id ?? ""}|${a.company_id ?? ""}|${a.role_id ?? ""}`
      )
    )
    const newOnes = rows.filter(
      (r) =>
        !oldKeys.has(
          `${r.profile_id ?? ""}|${r.company_id ?? ""}|${r.role_id ?? ""}`
        )
    )
    if (newOnes.length) {
      try {
        // Role-based assignments don't name a person directly — resolve each
        // to this project's current member (project_role_members) so the
        // right person/sub is notified. Unfilled roles notify no one.
        const roleIds = newOnes
          .map((r) => r.role_id)
          .filter(Boolean) as string[]
        const roleToMember = new Map<
          string,
          { profile_id: string | null; company_id: string | null }
        >()
        if (roleIds.length) {
          const { data: mems } = await supabase
            .from("project_role_members")
            .select("role_id, profile_id, company_id")
            .eq("project_id", parsed.project_id)
            .in("role_id", roleIds)
          for (const m of mems ?? []) {
            roleToMember.set(m.role_id, {
              profile_id: m.profile_id,
              company_id: m.company_id,
            })
          }
        }
        const resolved = newOnes
          .map((r) =>
            r.role_id
              ? roleToMember.get(r.role_id) ?? null
              : { profile_id: r.profile_id, company_id: r.company_id }
          )
          .filter(Boolean) as {
          profile_id: string | null
          company_id: string | null
        }[]
        // De-dupe recipients: a person/sub can be reached both directly and
        // via a role that resolves to them, which would otherwise double up
        // the in-app + email/SMS notifications.
        const notifySeen = new Set<string>()
        const notifyRows = resolved.filter((r) => {
          const key = `${r.profile_id ?? ""}|${r.company_id ?? ""}`
          if (notifySeen.has(key)) return false
          notifySeen.add(key)
          return true
        })
        if (notifyRows.length) {
          await notifyScheduleAssignees(
            notifyRows,
            parsed.project_id,
            id!,
            parsed.title,
            profile.id
          )
        }
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
  if (parsed.kind === "todo" && checklistItems.length) {
    const rows = checklistItems
      .filter((c) => c.label.trim() !== "")
      .map((c, i) => ({
        schedule_item_id: id!,
        label: c.label,
        is_done: c.is_done,
        position: i,
        assignee_profile_id: nz(c.assignee_profile_id),
        assignee_company_id: nz(c.assignee_company_id),
        assignee_role_id: nz(c.assignee_role_id),
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
  title: string,
  senderProfileId?: string
) {
  const supabase = await createSupabaseServerClient()
  const profileIds = rows.map((r) => r.profile_id).filter(Boolean) as string[]
  const companyIds = rows.map((r) => r.company_id).filter(Boolean) as string[]

  // In-app notifications for profile assignees. We capture the inserted
  // ids so we can stamp email_sent_at after the immediate send succeeds —
  // that keeps the digest cron from re-emailing rows we already covered.
  const insertedNotifIds: string[] = []
  if (profileIds.length) {
    const { data: insertedRows } = await supabase
      .from("notifications")
      .insert(
        profileIds.map((id) => ({
          recipient_id: id,
          type: "schedule_assignment",
          title: `Assigned: ${title}`,
          body: "You were assigned to a schedule item",
          link_url: `/projects/${projectId}/schedule`,
        }))
      )
      .select("id")
    for (const r of insertedRows ?? []) insertedNotifIds.push(r.id)
  }

  // Email + SMS — best-effort, never blocks save. Profiles with
  // email_digest_pref != 'immediate' are skipped here; their notification
  // row stays unstamped and the cron picks it up. We collect the
  // immediate-recipient emails and the phone-bearing companies in one
  // pass, then fan out in parallel so a slow Quo/Resend doesn't compound
  // onto the schedule save latency.
  try {
    const link = appUrl(`/projects/${projectId}/schedule`)
    const emails: string[] = []
    const immediateProfileIds: string[] = []
    const companyRecipients: {
      id: string
      name: string
      email: string | null
      phone: string | null
    }[] = []
    if (profileIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, email, email_digest_pref, notifications_enabled")
        .in("id", profileIds)
      for (const p of profs ?? []) {
        if (
          p.email &&
          p.email_digest_pref === "immediate" &&
          p.notifications_enabled
        ) {
          emails.push(p.email)
          immediateProfileIds.push(p.id)
        }
      }
    }
    if (companyIds.length) {
      const { data: cos } = await supabase
        .from("companies")
        .select("id, name, email, phone, notifications_enabled")
        .in("id", companyIds)
      for (const c of cos ?? []) {
        // Respect the per-company notification switch — a company with
        // notifications turned off (e.g. imported subs during testing) gets
        // no assignment email or SMS.
        if (!c.notifications_enabled) continue
        companyRecipients.push(c)
      }
    }

    const sends: Promise<unknown>[] = []
    if (emails.length) {
      sends.push(
        sendEmail({
          to: emails,
          subject: `New assignment: ${title}`,
          text: `You were assigned to "${title}" on the project. Open: ${link}`,
        })
          .then(async (res) => {
            // Stamp the notification rows for the profiles that just got an
            // immediate email so the daily digest doesn't re-include them.
            // We only stamp on a successful send so a transient Resend
            // failure leaves them eligible for the next cron run.
            if (res.sent && immediateProfileIds.length) {
              const { error: stampErr } = await supabase
                .from("notifications")
                .update({ email_sent_at: new Date().toISOString() })
                .in("recipient_id", immediateProfileIds)
                .in("id", insertedNotifIds)
              // If the stamp fails (CodeRabbit #32), the rows stay
              // unstamped and the digest cron will re-email them next
              // run. Log loudly so we can spot a chronic stamp failure
              // before users get duplicate notifications.
              if (stampErr) {
                console.warn(
                  "[assignment notify] email_sent_at stamp failed:",
                  stampErr.message
                )
              }
            }
          })
          .catch((e) => console.warn("assignment email failed:", e))
      )
    }
    // Companies get their own email + SMS sends (one per company, not a
    // combined blast) so each lands in the Communications feed attributed to
    // that company — and recipients never see each other's addresses.
    // Message is intentionally terse — texts charge per segment and busy
    // subs scan, not read.
    for (const c of companyRecipients) {
      const log = {
        project_id: projectId,
        company_id: c.id,
        sent_by: senderProfileId ?? null,
        kind: "schedule_assignment",
        counterparty_name: c.name,
      }
      if (c.email) {
        sends.push(
          sendEmail({
            to: [c.email],
            subject: `New assignment: ${title}`,
            text: `You were assigned to "${title}" on the project. Open: ${link}`,
            log,
          }).catch((e) => console.warn("assignment company email failed:", e))
        )
      }
      const e164 = c.phone ? normalizeE164(c.phone) : null
      if (e164) {
        const smsBody = `Hines Homes: you were assigned to "${title}". Details: ${link}`
        sends.push(
          sendQuoSms({ to: e164, content: smsBody, log }).then((r) => {
            if (!r.sent) {
              console.warn(
                `assignment SMS to ${e164} failed: ${r.reason ?? "unknown"}`
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
  return applyCascadeBatch(projectId, [movedId])
}

/**
 * Batched cascade for bulk moves. Loads the project graph ONCE, walks the
 * cascade for every seed id against the same in-memory map, and writes
 * each updated row exactly once. The single-id path is the trivial wrapper
 * above; the bulk-shift action calls this directly with the full seed
 * set so a 500-id shift doesn't trigger 500 round-trips for the same
 * `schedule_items.*` and `schedule_predecessors.*` data
 * (CodeRabbit #30 finding 7).
 *
 * Per-seed cascade results merge into a single Map keyed by item id, so
 * when two seeds independently push a successor's start_date, the later
 * (later in iteration order) one wins. With the cascade algorithm being
 * monotone-forward — successor dates only ever move LATER — this matches
 * the previous "loop applyCascade per seed" behaviour: the last write
 * wins, which is correct because each iteration is computed against the
 * updated graph the previous one left behind.
 */
async function applyCascadeBatch(
  projectId: string,
  seedIds: string[]
): Promise<string[]> {
  if (seedIds.length === 0) return []
  const supabase = await createSupabaseServerClient()
  const { data: items, error: itemsErr } = await supabase
    .from("schedule_items")
    .select("*")
    .eq("project_id", projectId)
  if (itemsErr) throw new Error(itemsErr.message)
  const { data: preds, error: predsErr } = await supabase
    .from("schedule_predecessors")
    .select("*")
  if (predsErr) throw new Error(predsErr.message)
  if (!items || !preds) return seedIds

  // Mutable copy keyed by id so successive seeds see the cascade updates
  // from prior seeds. cascadeFromPredecessors is pure — we have to
  // splice the updates back into the list ourselves.
  const itemMap = new Map(items.map((it) => [it.id, { ...it }]))
  const allUpdates = new Map<string, { start_date: string; end_date: string }>()
  const touched = new Set<string>()
  for (const seed of seedIds) {
    touched.add(seed)
    const currentItems = Array.from(itemMap.values())
    const updates = cascadeFromPredecessors(currentItems, preds, seed)
    for (const u of updates) {
      allUpdates.set(u.id, {
        start_date: u.start_date,
        end_date: u.end_date,
      })
      const prior = itemMap.get(u.id)
      if (prior) {
        itemMap.set(u.id, {
          ...prior,
          start_date: u.start_date,
          end_date: u.end_date,
        })
      }
      touched.add(u.id)
    }
  }

  for (const [id, dates] of allUpdates) {
    const { error } = await supabase
      .from("schedule_items")
      .update(dates)
      .eq("id", id)
    if (error) {
      throw new Error(
        `Cascade failed at ${id}: ${error.message}. Some successor dates may be partially updated.`
      )
    }
  }
  return Array.from(touched)
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

  // Job Start / Substantial Completion can be moved and completed but never
  // deleted. A DB trigger backstops this; checking here gives a clear error
  // before any predecessor reassignments are applied.
  const { data: target, error: targetErr } = await supabase
    .from("schedule_items")
    .select("milestone, title")
    .eq("id", parsed.id)
    .maybeSingle()
  if (targetErr) throw new Error(targetErr.message)
  if (target?.milestone) {
    throw new Error(
      `"${target.title}" is a protected schedule milestone and can't be deleted.`
    )
  }

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
  move_reason: MoveReason.nullish(),
})

export async function moveScheduleItem(input: {
  id: string
  project_id: string
  start_date: string
  end_date: string
  move_reason?: MoveReasonT | null
}) {
  const profile = await requireStaff()
  const parsed = MoveInput.parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: item, error: itemErr } = await supabase
    .from("schedule_items")
    .select("kind, start_date, end_date, project_id")
    .eq("id", parsed.id)
    .maybeSingle()
  if (itemErr) throw new Error(itemErr.message)
  if (!item || item.project_id !== parsed.project_id) {
    throw new Error("Schedule item not found in this project.")
  }
  const changed =
    item.start_date !== parsed.start_date || item.end_date !== parsed.end_date
  let baselineSetAt: string | null = null
  if (item.kind === "work" && changed) {
    baselineSetAt = await getBaselineSetAt(supabase, parsed.project_id)
    if (baselineSetAt && !parsed.move_reason) {
      throw new Error(MOVE_REASON_MSG)
    }
  }

  const { error } = await supabase
    .from("schedule_items")
    .update({ start_date: parsed.start_date, end_date: parsed.end_date })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  if (item.kind === "work" && changed && baselineSetAt && parsed.move_reason) {
    await logMoveReasons(supabase, [
      {
        schedule_item_id: parsed.id,
        delay_days: dateShiftDays(
          item.start_date,
          item.end_date,
          parsed.start_date,
          parsed.end_date
        ),
        reason_category: parsed.move_reason.reason_category,
        notes: nz(parsed.move_reason.notes),
        logged_by: profile.id,
      },
    ])
  }
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
  if (status === "complete") {
    const { data: item, error: itemErr } = await supabase
      .from("schedule_items")
      .select("kind, status, project_id")
      .eq("id", id)
      .maybeSingle()
    if (itemErr) throw new Error(itemErr.message)
    if (
      item &&
      item.kind === "work" &&
      item.status !== "complete" &&
      !(await getBaselineSetAt(supabase, item.project_id))
    ) {
      throw new Error(BASELINE_COMPLETE_MSG)
    }
  }
  const { error } = await supabase
    .from("schedule_items")
    .update({ status })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/schedule`)
}

// Lightweight single-field edits for the to-do spreadsheet view. Unlike
// saveScheduleItem (which replaces assignments/checklist/predecessors on every
// call), this only patches the simple scalar columns it's given, so inline
// grid edits don't disturb a to-do's relationships. Each field is applied only
// when explicitly present.
const TodoFieldsInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1, "Title is required").max(500).optional(),
  due_date: z
    .string()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  status: z
    .enum(["not_started", "in_progress", "complete", "delayed"])
    .optional(),
  priority: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
})

export async function updateScheduleItemFields(
  input: z.input<typeof TodoFieldsInput>
) {
  await requireStaff()
  const parsed = TodoFieldsInput.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, project_id, ...fields } = parsed.data
  const update: TablesUpdate<"schedule_items"> = {}
  if (fields.title !== undefined) update.title = fields.title
  if (fields.due_date !== undefined) update.due_date = fields.due_date
  if (fields.status !== undefined) update.status = fields.status
  if (fields.priority !== undefined) update.priority = fields.priority
  if (Object.keys(update).length === 0) return

  const supabase = await createSupabaseServerClient()
  // This path serves the to-do grid, but gate anyway in case a work item id
  // is ever routed through it.
  if (fields.status === "complete") {
    const { data: item, error: itemErr } = await supabase
      .from("schedule_items")
      .select("kind, status")
      .eq("id", id)
      .eq("project_id", project_id)
      .maybeSingle()
    if (itemErr) throw new Error(itemErr.message)
    if (
      item &&
      item.kind === "work" &&
      item.status !== "complete" &&
      !(await getBaselineSetAt(supabase, project_id))
    ) {
      throw new Error(BASELINE_COMPLETE_MSG)
    }
  }
  const { error } = await supabase
    .from("schedule_items")
    .update(update)
    .eq("id", id)
    .eq("project_id", project_id)
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
  const profile = await requireStaff()
  const parsed = SendSubTextInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Verify the company is actually assigned to this schedule item.
  const { data: assignment, error: aErr } = await supabase
    .from("schedule_assignments")
    .select("id, schedule_items!inner(project_id)")
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

  const result = await sendQuoSms({
    to: normalized,
    content: parsed.message,
    log: {
      project_id:
        (assignment as unknown as { schedule_items: { project_id: string } | null })
          .schedule_items?.project_id ?? null,
      company_id: parsed.company_id,
      sent_by: profile.id,
      kind: "manual_sms",
      counterparty_name: company.name,
    },
  })
  if (!result.sent) {
    return { ok: false, error: result.reason ?? "Failed to send text." }
  }
  return { ok: true, to: normalized, company_name: company.name }
}

const ScheduleCommentInput = z.object({
  schedule_item_id: z.string().min(1),
  project_id: z.string().min(1),
  body: z.string().min(1, "Comment is empty"),
})

/**
 * Comment on a schedule item — staff or an assigned trade (RLS policy
 * sic_trade_insert re-verifies the assignment; clients have no policy and
 * are rejected by RLS). Fans out bell notifications: trade comments alert
 * all staff, staff comments alert the item's assignees.
 */
export async function postScheduleItemComment(input: {
  schedule_item_id: string
  project_id: string
  body: string
}) {
  const profile = await requireSession()
  const parsed = ScheduleCommentInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const authorName = profile.full_name ?? profile.email ?? "Someone"

  const { error } = await supabase.from("schedule_item_comments").insert({
    schedule_item_id: parsed.schedule_item_id,
    author_id: profile.id,
    author_name: authorName,
    body: parsed.body.trim(),
  })
  if (error) throw new Error(error.message)

  try {
    const { data: item } = await supabase
      .from("schedule_items")
      .select("title")
      .eq("id", parsed.schedule_item_id)
      .maybeSingle()
    // Project name is best-effort — trades can't read the projects table.
    const { data: proj } = await supabase
      .from("projects")
      .select("name")
      .eq("id", parsed.project_id)
      .maybeSingle()

    // Staff comment → alert the item's assignees: directly assigned profiles
    // plus trade logins belonging to assigned companies.
    let counterpartyIds: string[] = []
    if (profile.role === "staff") {
      const { data: assignments } = await supabase
        .from("schedule_assignments")
        .select("profile_id, company_id")
        .eq("schedule_item_id", parsed.schedule_item_id)
      const profileIds = (assignments ?? [])
        .map((a) => a.profile_id)
        .filter(Boolean) as string[]
      const companyIds = (assignments ?? [])
        .map((a) => a.company_id)
        .filter(Boolean) as string[]
      if (companyIds.length) {
        const { data: tradeProfiles } = await supabase
          .from("profiles")
          .select("id")
          .in("company_id", companyIds)
          .eq("role", "trade")
        for (const p of tradeProfiles ?? []) profileIds.push(p.id)
      }
      counterpartyIds = [...new Set(profileIds)]
    }

    await notifyCommentPosted({
      entityLabel: item?.title ? `Schedule: ${item.title}` : "a schedule item",
      projectName: proj?.name ?? null,
      authorName,
      authorIsStaff: profile.role === "staff",
      authorProfileId: profile.id,
      body: parsed.body.trim(),
      staffLink: `/projects/${parsed.project_id}/schedule?open=${parsed.schedule_item_id}`,
      counterpartyProfileIds: counterpartyIds,
      // Trades can open the project schedule page (only clients can't) —
      // same deep link works for both sides.
      counterpartyLink: `/projects/${parsed.project_id}/schedule?open=${parsed.schedule_item_id}`,
    })
  } catch (e) {
    console.warn("schedule comment notification failed:", e)
  }

  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  revalidatePath(`/projects/${parsed.project_id}/communications`)
  revalidatePath("/my-assignments")
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
// Copy a to-do to the same job or to other jobs
// ============================================================================
//
// "Copy to job" duplicates a to-do (title, description, priority, recurrence,
// checklist + assignees, and direct assignments) into one or more target
// projects. When the source to-do nests under a work item, we try to re-link
// it under a work item with the SAME TITLE in the target project. If no such
// parent exists ("parent not obvious"), the caller must supply a parent_id
// and due_date for that target — the UI prompts for them.

export type CopyTodoData = {
  source: {
    title: string
    parent_title: string | null
    due_date: string | null
    has_anchor: boolean
  }
  projects: {
    id: string
    label: string
    work_items: { id: string; title: string }[]
  }[]
}

function projectLabel(p: {
  name: string | null
  project_number: string | number | null
  address: string | null
}): string {
  return (
    p.name ||
    p.address ||
    (p.project_number != null ? `Project #${p.project_number}` : "Untitled")
  )
}

/**
 * Loads the data the "Copy to job" dialog needs: the source to-do's shape and
 * every project (with its work items) the staff member can copy into. RLS
 * scopes the project + work-item reads to what the caller may see.
 */
export async function getCopyTodoData(input: {
  source_item_id: string
}): Promise<CopyTodoData> {
  await requireStaff()
  const parsed = z.object({ source_item_id: z.string() }).parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: source, error: srcErr } = await supabase
    .from("schedule_items")
    .select(
      "id, kind, title, parent_id, due_date, parent_anchor, parent_offset_days"
    )
    .eq("id", parsed.source_item_id)
    .maybeSingle()
  if (srcErr) throw new Error(srcErr.message)
  if (!source) throw new Error("To-do not found.")
  if (source.kind !== "todo") throw new Error("Only to-dos can be copied.")

  let parentTitle: string | null = null
  if (source.parent_id) {
    const { data: parent } = await supabase
      .from("schedule_items")
      .select("title")
      .eq("id", source.parent_id)
      .maybeSingle()
    parentTitle = parent?.title ?? null
  }

  const [{ data: projects, error: projErr }, { data: workItems, error: wiErr }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, name, project_number, address")
        .order("created_at", { ascending: false }),
      supabase
        .from("schedule_items")
        .select("id, project_id, title")
        .eq("kind", "work")
        .order("position", { ascending: true }),
    ])
  if (projErr) throw new Error(projErr.message)
  if (wiErr) throw new Error(wiErr.message)

  const byProject = new Map<string, { id: string; title: string }[]>()
  for (const w of workItems ?? []) {
    const arr = byProject.get(w.project_id) ?? []
    arr.push({ id: w.id, title: w.title })
    byProject.set(w.project_id, arr)
  }

  return {
    source: {
      title: source.title,
      parent_title: parentTitle,
      due_date: source.due_date,
      has_anchor: source.parent_anchor != null,
    },
    projects: (projects ?? []).map((p) => ({
      id: p.id,
      label: projectLabel(p),
      work_items: byProject.get(p.id) ?? [],
    })),
  }
}

const CopyTodoInput = z.object({
  source_item_id: z.string(),
  targets: z
    .array(
      z.object({
        project_id: z.string(),
        // Explicit parent chosen in the UI. When absent, the action tries to
        // auto-match a work item by the source parent's title.
        parent_id: optStr,
        // Explicit due date chosen in the UI (used when the parent isn't
        // anchored / not auto-resolved). When absent, falls back to the
        // source's due date.
        due_date: optStr,
      })
    )
    .min(1)
    .max(50),
})

export type CopyTodoResult = {
  created: number
  skipped: { project_id: string; reason: string }[]
}

export async function copyTodoToTargets(input: {
  source_item_id: string
  targets: { project_id: string; parent_id?: string | null; due_date?: string | null }[]
}): Promise<CopyTodoResult> {
  const profile = await requireStaff()
  const parsed = CopyTodoInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Load the source to-do, its checklist, and direct assignments once.
  const { data: source, error: srcErr } = await supabase
    .from("schedule_items")
    .select(
      "id, kind, title, description, priority, recurrence_rule, due_date, parent_id, parent_anchor, parent_offset_days"
    )
    .eq("id", parsed.source_item_id)
    .maybeSingle()
  if (srcErr) throw new Error(srcErr.message)
  if (!source) throw new Error("To-do not found.")
  if (source.kind !== "todo") throw new Error("Only to-dos can be copied.")

  // Resolve the source parent's title so we can auto-match in target projects.
  let sourceParentTitle: string | null = null
  if (source.parent_id) {
    const { data: parent } = await supabase
      .from("schedule_items")
      .select("title")
      .eq("id", source.parent_id)
      .maybeSingle()
    sourceParentTitle = parent?.title ?? null
  }

  const [{ data: checklist }, { data: assignments }] = await Promise.all([
    supabase
      .from("todo_checklist_items")
      .select(
        "label, is_done, position, assignee_profile_id, assignee_company_id, assignee_role_id"
      )
      .eq("schedule_item_id", source.id)
      .order("position", { ascending: true }),
    supabase
      .from("schedule_assignments")
      .select("profile_id, company_id, role_id")
      .eq("schedule_item_id", source.id),
  ])

  const created: string[] = []
  const touchedProjects = new Set<string>()
  const skipped: { project_id: string; reason: string }[] = []

  for (const t of parsed.targets) {
    // Confirm the target project is visible to this staff member.
    const { data: proj, error: projErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", t.project_id)
      .maybeSingle()
    if (projErr) throw new Error(projErr.message)
    if (!proj) {
      skipped.push({ project_id: t.project_id, reason: "project not found" })
      continue
    }

    // Resolve the parent work item in the target project.
    let parentId = nz(t.parent_id)
    if (parentId) {
      const { data: chosen } = await supabase
        .from("schedule_items")
        .select("id")
        .eq("id", parentId)
        .eq("project_id", t.project_id)
        .eq("kind", "work")
        .maybeSingle()
      if (!chosen) {
        skipped.push({
          project_id: t.project_id,
          reason: "chosen parent not found in target project",
        })
        continue
      }
    } else if (sourceParentTitle) {
      // Auto-match a work item with the same title (case-insensitive).
      const { data: matches } = await supabase
        .from("schedule_items")
        .select("id, title")
        .eq("project_id", t.project_id)
        .eq("kind", "work")
      const match = (matches ?? []).find(
        (m) =>
          m.title.trim().toLowerCase() ===
          sourceParentTitle!.trim().toLowerCase()
      )
      parentId = match?.id ?? null
    }

    // Resolve due date / anchor. If the source was anchored AND we have a
    // parent, replicate the anchor against the new parent. Otherwise use the
    // explicit due date, falling back to the source's due date.
    let dueDate: string | null = nz(t.due_date) ?? source.due_date
    let anchor: "start" | "end" | null = null
    let offset: number | null = null
    if (source.parent_anchor && parentId) {
      const { data: parentRow } = await supabase
        .from("schedule_items")
        .select("start_date, end_date")
        .eq("id", parentId)
        .maybeSingle()
      if (parentRow) {
        anchor = source.parent_anchor
        offset = source.parent_offset_days ?? 0
        dueDate = recomputeAnchoredDueDate(parentRow, anchor, offset)
      }
    }

    const { data: newItem, error: insErr } = await supabase
      .from("schedule_items")
      .insert({
        project_id: t.project_id,
        parent_id: parentId,
        kind: "todo",
        title: source.title,
        description: source.description,
        priority: source.priority,
        recurrence_rule: source.recurrence_rule,
        due_date: dueDate,
        parent_anchor: anchor,
        parent_offset_days: offset,
        status: "not_started",
        created_by: profile.id,
      })
      .select("id")
      .single()
    if (insErr) {
      skipped.push({ project_id: t.project_id, reason: insErr.message })
      continue
    }

    // Copy checklist (reset is_done — a copy starts fresh). Role assignees
    // copy as-is: a role is project-agnostic and re-resolves through the
    // target project's role map.
    if (checklist && checklist.length) {
      const rows = checklist.map((c, i) => ({
        schedule_item_id: newItem.id,
        label: c.label,
        is_done: false,
        position: i,
        assignee_profile_id: c.assignee_profile_id,
        assignee_company_id: c.assignee_company_id,
        assignee_role_id: c.assignee_role_id,
      }))
      const { error: clErr } = await supabase
        .from("todo_checklist_items")
        .insert(rows)
      if (clErr) {
        console.warn("[copyTodoToTargets] checklist copy failed:", clErr.message)
      }
    }

    // Copy direct assignments (role assignments re-resolve per project).
    if (assignments && assignments.length) {
      const rows = assignments
        .filter((a) => a.profile_id || a.company_id || a.role_id)
        .map((a) => ({
          schedule_item_id: newItem.id,
          profile_id: a.profile_id,
          company_id: a.company_id,
          role_id: a.role_id,
        }))
      if (rows.length) {
        const { error: asErr } = await supabase
          .from("schedule_assignments")
          .insert(rows)
        if (asErr) {
          console.warn(
            "[copyTodoToTargets] assignment copy failed:",
            asErr.message
          )
        }
      }
    }

    created.push(newItem.id)
    touchedProjects.add(t.project_id)
  }

  for (const pid of touchedProjects) {
    revalidatePath(`/projects/${pid}/schedule`)
  }
  return { created: created.length, skipped }
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
  move_reason: MoveReason.nullish(),
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

  // Pre-baseline, work items can't be completed — drop them from the batch
  // with an explanatory skip instead of failing the whole selection (to-dos
  // in the same selection still complete fine).
  let idsToUpdate = parsed.ids
  const preSkipped: { id: string; reason: string }[] = []
  if (
    parsed.status === "complete" &&
    !(await getBaselineSetAt(supabase, parsed.project_id))
  ) {
    const { data: kinds, error: kErr } = await supabase
      .from("schedule_items")
      .select("id, kind")
      .in("id", parsed.ids)
      .eq("project_id", parsed.project_id)
    if (kErr) throw new Error(kErr.message)
    const workIds = new Set(
      (kinds ?? []).filter((k) => k.kind === "work").map((k) => k.id)
    )
    idsToUpdate = parsed.ids.filter((id) => !workIds.has(id))
    for (const id of workIds) {
      preSkipped.push({
        id,
        reason: "baseline not set — lock it before completing work items",
      })
    }
    if (idsToUpdate.length === 0) {
      return { ok: 0, skipped: preSkipped }
    }
  }

  // Single batched UPDATE — RLS will silently drop rows the user can't write,
  // so we compare returned-vs-requested to detect that case.
  const { data, error } = await supabase
    .from("schedule_items")
    .update({ status: parsed.status })
    .in("id", idsToUpdate)
    .eq("project_id", parsed.project_id)
    .select("id")
  if (error) throw new Error(error.message)
  const updated = new Set((data ?? []).map((r) => r.id))
  const skipped = [
    ...preSkipped,
    ...idsToUpdate
      .filter((id) => !updated.has(id))
      .map((id) => ({ id, reason: "not found in project (or RLS denied)" })),
  ]
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: updated.size, skipped }
}

export async function bulkShiftScheduleDates(input: {
  project_id: string
  ids: string[]
  days: number
  move_reason?: MoveReasonT | null
}): Promise<BulkScheduleResult> {
  const profile = await requireStaff()
  const parsed = BulkShiftInput.parse(input)
  if (parsed.days === 0) {
    return { ok: 0, skipped: parsed.ids.map((id) => ({ id, reason: "zero days" })) }
  }
  const supabase = await createSupabaseServerClient()
  const { data: items, error: selErr } = await supabase
    .from("schedule_items")
    .select("id, kind, start_date, end_date, due_date")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
  if (selErr) throw new Error(selErr.message)

  // Post-baseline, shifting dated work items requires a reason. Bail before
  // touching anything so the shift stays all-or-nothing on this rule.
  const datedWork = (items ?? []).filter(
    (i) => i.kind === "work" && (i.start_date || i.end_date)
  )
  let baselineSetAt: string | null = null
  if (datedWork.length > 0) {
    baselineSetAt = await getBaselineSetAt(supabase, parsed.project_id)
    if (baselineSetAt && !parsed.move_reason) {
      return {
        ok: 0,
        skipped: parsed.ids.map((id) => ({
          id,
          reason: "baseline is set — pick a reason for the date shift",
        })),
      }
    }
  }

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

  // One schedule_delays row per shifted work item, all under the reason the
  // user picked — the whole selection moved for the same cause.
  if (baselineSetAt && parsed.move_reason) {
    const movedSet = new Set(movedIds)
    await logMoveReasons(
      supabase,
      datedWork
        .filter((w) => movedSet.has(w.id))
        .map((w) => ({
          schedule_item_id: w.id,
          delay_days: parsed.days,
          reason_category: parsed.move_reason!.reason_category,
          notes: nz(parsed.move_reason!.notes),
          logged_by: profile.id,
        }))
    )
  }

  // Batched cascade: load the project graph once, walk every seed
  // against the same in-memory copy, write each affected row exactly
  // once. The previous per-seed loop reloaded the full graph for every
  // moved item, which got expensive at the 500-id selection cap.
  const cascadeMoved = new Set<string>(
    await applyCascadeBatch(parsed.project_id, movedIds)
  )
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

  // Milestones never delete — drop them from the batch with a skip note so
  // the rest of the selection isn't blocked by the DB trigger's exception.
  const { data: markerRows, error: mErr } = await supabase
    .from("schedule_items")
    .select("id, milestone")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
    .not("milestone", "is", null)
  if (mErr) throw new Error(mErr.message)
  const milestoneIds = new Set((markerRows ?? []).map((r) => r.id))
  const deletableIds = parsed.ids.filter((id) => !milestoneIds.has(id))
  const milestoneSkipped = Array.from(milestoneIds).map((id) => ({
    id,
    reason: "protected milestone — can't be deleted",
  }))
  if (deletableIds.length === 0) {
    return { ok: 0, skipped: milestoneSkipped }
  }

  // Defensive: refuse if any selected item is a predecessor of an item that
  // ISN'T also being deleted. Otherwise the FK cascade silently drops the
  // dependency and the surviving successor's schedule shifts unexpectedly.
  // For an explicit reassignment flow, the single-item deleteScheduleItem
  // already exists — point staff there.
  const idSet = new Set(deletableIds)
  const { data: preds, error: pErr } = await supabase
    .from("schedule_predecessors")
    .select("item_id, predecessor_id")
    .in("predecessor_id", deletableIds)
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
    .in("id", deletableIds)
    .eq("project_id", parsed.project_id)
    .select("id")
  if (error) throw new Error(error.message)
  const deleted = new Set((data ?? []).map((r) => r.id))
  const skipped = [
    ...milestoneSkipped,
    ...deletableIds
      .filter((id) => !deleted.has(id))
      .map((id) => ({ id, reason: "not found in project (or RLS denied)" })),
  ]
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: deleted.size, skipped }
}

// ============================================================================
// Bulk assign / unassign a profile across selected schedule items.
// ============================================================================
//
// Both paths follow the same shape as the other bulk operations: scoped by
// project_id, capped at 500 ids, return BulkScheduleResult.
//
// Assign is idempotent: if the profile is already on a row, that row counts
// as "ok" rather than failing. We achieve this by checking which rows
// already have the assignment and only inserting the missing ones. Reasons
// "already assigned" appear in `skipped` so the staff sees the breakdown
// without it looking like an error.
//
// Unassign deletes the (item, profile) pair where present. Missing rows count
// as "skipped: not assigned" so the user knows they weren't on those items.

const BulkAssignInput = BulkIdsInput.extend({
  profile_id: z.string().uuid(),
})

export async function bulkAssignProfileToScheduleItems(input: {
  project_id: string
  ids: string[]
  profile_id: string
}): Promise<BulkScheduleResult> {
  await requireStaff()
  const parsed = BulkAssignInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Limit to items in this project so a forged id can't assign someone
  // to a different project's row even with valid staff session.
  const { data: items, error: itemsErr } = await supabase
    .from("schedule_items")
    .select("id")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
  if (itemsErr) throw new Error(itemsErr.message)
  const validIds = new Set((items ?? []).map((i) => i.id))
  const skipped: { id: string; reason: string }[] = []
  for (const id of parsed.ids) {
    if (!validIds.has(id)) {
      skipped.push({ id, reason: "not found in project (or RLS denied)" })
    }
  }
  if (validIds.size === 0) return { ok: 0, skipped }

  const { data: existing, error: exErr } = await supabase
    .from("schedule_assignments")
    .select("schedule_item_id")
    .in("schedule_item_id", Array.from(validIds))
    .eq("profile_id", parsed.profile_id)
  if (exErr) throw new Error(exErr.message)
  const alreadyAssigned = new Set(
    (existing ?? []).map((r) => r.schedule_item_id)
  )

  const toInsert = Array.from(validIds).filter(
    (id) => !alreadyAssigned.has(id)
  )
  for (const id of alreadyAssigned) {
    skipped.push({ id, reason: "already assigned" })
  }

  let inserted = 0
  if (toInsert.length > 0) {
    const rows = toInsert.map((id) => ({
      schedule_item_id: id,
      profile_id: parsed.profile_id,
      company_id: null,
    }))
    const { data, error } = await supabase
      .from("schedule_assignments")
      .insert(rows)
      .select("schedule_item_id")
    if (error) throw new Error(error.message)
    inserted = (data ?? []).length
    const insertedSet = new Set((data ?? []).map((r) => r.schedule_item_id))
    for (const id of toInsert) {
      if (!insertedSet.has(id)) {
        skipped.push({ id, reason: "insert blocked (RLS)" })
      }
    }
  }
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: inserted, skipped }
}

export async function bulkUnassignProfileFromScheduleItems(input: {
  project_id: string
  ids: string[]
  profile_id: string
}): Promise<BulkScheduleResult> {
  await requireStaff()
  const parsed = BulkAssignInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // RLS already gates per-row, but scope to the project explicitly so the
  // server can report "not found in project" for the skipped breakdown
  // (otherwise we couldn't tell missing-row from RLS-blocked).
  const { data: items, error: itemsErr } = await supabase
    .from("schedule_items")
    .select("id")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
  if (itemsErr) throw new Error(itemsErr.message)
  const validIds = new Set((items ?? []).map((i) => i.id))
  const skipped: { id: string; reason: string }[] = []
  for (const id of parsed.ids) {
    if (!validIds.has(id)) {
      skipped.push({ id, reason: "not found in project (or RLS denied)" })
    }
  }
  if (validIds.size === 0) return { ok: 0, skipped }

  const { data: deleted, error } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("profile_id", parsed.profile_id)
    .in("schedule_item_id", Array.from(validIds))
    .select("schedule_item_id")
  if (error) throw new Error(error.message)
  const removed = new Set((deleted ?? []).map((r) => r.schedule_item_id))
  for (const id of validIds) {
    if (!removed.has(id)) {
      skipped.push({ id, reason: "not assigned" })
    }
  }
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: removed.size, skipped }
}

// ============================================================================
// Schedule baseline + protected milestones
// ============================================================================

export type SetBaselineResult = { ok: true } | { ok: false; error: string }

/**
 * Locks the current plan as the baseline: copies every work item's start/end
 * into baseline_start_date/baseline_end_date (via the atomic
 * set_schedule_baseline RPC) and stamps projects.baseline_set_at. Running it
 * again re-baselines — the health banner asks for explicit confirmation
 * before doing that, since variance resets to zero.
 *
 * Typed result (not throw): Next.js masks thrown messages in production and
 * these failures are user-actionable ("give the milestones dates first").
 */
export async function setScheduleBaseline(input: {
  project_id: string
}): Promise<SetBaselineResult> {
  await requireStaff()
  const parsed = z.object({ project_id: z.string().uuid() }).parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: markers, error: mErr } = await supabase
    .from("schedule_items")
    .select("milestone, start_date, end_date")
    .eq("project_id", parsed.project_id)
    .not("milestone", "is", null)
  if (mErr) return { ok: false, error: mErr.message }
  const jobStart = (markers ?? []).find((m) => m.milestone === "job_start")
  const subComplete = (markers ?? []).find(
    (m) => m.milestone === "substantial_completion"
  )
  if (!jobStart || !subComplete) {
    return {
      ok: false,
      error:
        "This project is missing its Job Start / Substantial Completion milestones — create them first.",
    }
  }
  if (!jobStart.start_date || !subComplete.end_date) {
    return {
      ok: false,
      error:
        "Give Job Start and Substantial Completion dates before locking the baseline.",
    }
  }

  const { error: rpcErr } = await supabase.rpc("set_schedule_baseline", {
    p_project: parsed.project_id,
  })
  if (rpcErr) return { ok: false, error: rpcErr.message }
  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { ok: true }
}

/**
 * Ensures a project has its Job Start / Substantial Completion milestones.
 * ADOPTS before creating: if an unflagged work item already carries one of
 * those titles (case-insensitive — the Template ships with them), that item
 * becomes the milestone with its real dates intact. Only when no titled item
 * exists is a fresh undated row created. Idempotent; safe to call from
 * project-creation paths and from the health banner's fallback button.
 */
export async function ensureProjectMilestones(input: {
  project_id: string
}): Promise<{ adopted: number; created: number }> {
  const profile = await requireStaff()
  const parsed = z.object({ project_id: z.string().uuid() }).parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: workItems, error: exErr } = await supabase
    .from("schedule_items")
    .select("id, title, milestone, position, created_at")
    .eq("project_id", parsed.project_id)
    .eq("kind", "work")
  if (exErr) throw new Error(exErr.message)
  const items = workItems ?? []
  const have = new Set(items.map((i) => i.milestone).filter(Boolean))
  if (have.has("job_start") && have.has("substantial_completion")) {
    return { adopted: 0, created: 0 }
  }

  const MILESTONES: {
    kind: "job_start" | "substantial_completion"
    title: string
  }[] = [
    { kind: "job_start", title: "Job Start" },
    { kind: "substantial_completion", title: "Substantial Completion" },
  ]

  let adopted = 0
  const missingAfterAdoption: (typeof MILESTONES)[number][] = []
  for (const m of MILESTONES) {
    if (have.has(m.kind)) continue
    // Earliest-created title match wins — on template-built jobs that's the
    // copied template item.
    const match = items
      .filter(
        (i) =>
          !i.milestone &&
          i.title.trim().toLowerCase() === m.title.toLowerCase()
      )
      .sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      )[0]
    if (!match) {
      missingAfterAdoption.push(m)
      continue
    }
    const { error: adoptErr } = await supabase
      .from("schedule_items")
      .update({ milestone: m.kind })
      .eq("id", match.id)
    // 23505 = a concurrent call flagged one first — that's a success state.
    if (adoptErr && (adoptErr as { code?: string }).code !== "23505") {
      throw new Error(adoptErr.message)
    }
    adopted++
  }

  let created = 0
  if (missingAfterAdoption.length > 0) {
    // Bracket the existing schedule so new rows land at the visual edges.
    const positions = items.map((i) => i.position)
    const minPos = positions.length ? Math.min(...positions) : 0
    const maxPos = positions.length ? Math.max(...positions) : 0
    const rows = missingAfterAdoption.map((m) => ({
      project_id: parsed.project_id,
      kind: "work" as const,
      title: m.title,
      milestone: m.kind,
      position: m.kind === "job_start" ? minPos - 1 : maxPos + 1,
      created_by: profile.id,
    }))
    const { error: insErr } = await supabase.from("schedule_items").insert(rows)
    if (insErr && (insErr as { code?: string }).code !== "23505") {
      throw new Error(insErr.message)
    }
    created = rows.length
  }

  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  return { adopted, created }
}
