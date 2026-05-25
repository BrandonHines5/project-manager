"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { wouldCreateCycle, cascadeFromPredecessors } from "@/lib/schedule/scheduling"
import type { RecurrenceRule } from "@/lib/schedule/recurrence"
import { sendEmail, appUrl } from "@/lib/email"

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
    status: z
      .enum(["not_started", "in_progress", "complete", "delayed"])
      .default("not_started"),
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
  await requireStaff()
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

  const baseRow = {
    project_id: parsed.project_id,
    parent_id: nz(parsed.parent_id),
    kind: parsed.kind,
    title: parsed.title,
    description: nz(parsed.description),
    start_date: startD,
    end_date: endD,
    due_date: nz(parsed.due_date),
    duration_days: duration,
    status: parsed.status,
    recurrence_rule: (parsed.recurrence_rule ?? null) as RecurrenceRule | null,
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
      .insert(baseRow)
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

  await applyCascade(parsed.project_id, id!)

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

  // Email — best-effort, never blocks save
  try {
    const link = appUrl(`/projects/${projectId}/schedule`)
    const emails: string[] = []
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
        .select("email")
        .in("id", companyIds)
      for (const c of cos ?? []) if (c.email) emails.push(c.email)
    }
    if (emails.length) {
      await sendEmail({
        to: emails,
        subject: `New assignment: ${title}`,
        text: `You were assigned to "${title}" on the project. Open: ${link}`,
      })
    }
  } catch (e) {
    console.warn("schedule assignment email failed:", e)
  }
  void scheduleItemId
}

async function applyCascade(projectId: string, movedId: string) {
  const supabase = await createSupabaseServerClient()
  const { data: items } = await supabase
    .from("schedule_items")
    .select("*")
    .eq("project_id", projectId)
  const { data: preds } = await supabase
    .from("schedule_predecessors")
    .select("*")
  if (!items || !preds) return
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
}

const IdProjectInput = z.object({ id: z.string(), project_id: z.string() })

export async function deleteScheduleItem(input: { id: string; project_id: string }) {
  await requireStaff()
  const parsed = IdProjectInput.parse(input)
  const supabase = await createSupabaseServerClient()
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
      await applyCascade(project_id, schedule_item_id)
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
  await applyCascade(parsed.project_id, parsed.id)
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
