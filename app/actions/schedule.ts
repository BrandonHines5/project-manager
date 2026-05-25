"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { wouldCreateCycle, cascadeFromPredecessors } from "@/lib/schedule/scheduling"
import type { RecurrenceRule } from "@/lib/schedule/recurrence"
import { sendEmail, appUrl } from "@/lib/email"

const NULLABLE_DATE = z.string().optional().or(z.literal(""))

const Recurrence = z
  .object({
    freq: z.enum(["daily", "weekly", "biweekly", "monthly"]),
    interval: z.number().int().positive().optional(),
    until: z.string().optional(),
    count: z.number().int().positive().optional(),
  })
  .nullable()
  .optional()

const ScheduleItemInput = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().optional(),
  kind: z.enum(["work", "todo"]),
  title: z.string().min(1, "Required").max(300),
  description: z.string().optional().nullable(),
  start_date: NULLABLE_DATE,
  end_date: NULLABLE_DATE,
  due_date: NULLABLE_DATE,
  status: z
    .enum(["not_started", "in_progress", "complete", "delayed"])
    .default("not_started"),
  recurrence_rule: Recurrence,
  assignments: z
    .array(
      z.object({
        profile_id: z.string().uuid().nullable().optional(),
        company_id: z.string().uuid().nullable().optional(),
      })
    )
    .default([]),
  checklist: z
    .array(z.object({ id: z.string().optional(), label: z.string(), is_done: z.boolean() }))
    .default([]),
  predecessors: z
    .array(
      z.object({
        predecessor_id: z.string().uuid(),
        dep_type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
        lag_days: z.number().int().default(0),
      })
    )
    .default([]),
})

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
  const dbg = (step: string, extra?: unknown) =>
    console.log(`[saveScheduleItem] ${step}`, extra ?? "")
  try {
    dbg("0:enter", { hasId: !!input.id, kind: input.kind })
    await requireStaff()
    dbg("1:requireStaff_ok")
    // Write the raw input to debug_log so we can inspect it server-side later.
    const debugSb = await createSupabaseServerClient()
    await debugSb.from("debug_log").insert({
      tag: "saveScheduleItem:input",
      payload: input as unknown as Record<string, unknown>,
    })
    let parsed: ScheduleItemInputT
    try {
      parsed = ScheduleItemInput.parse(input)
    } catch (zerr) {
      if (zerr instanceof z.ZodError) {
        await debugSb.from("debug_log").insert({
          tag: "saveScheduleItem:zod_error",
          payload: { issues: zerr.issues, input: input as unknown as Record<string, unknown> },
        })
      }
      throw zerr
    }
    dbg("2:zod_ok", { title: parsed.title, status: parsed.status })
    const supabase = await createSupabaseServerClient()

  const duration =
    parsed.start_date && parsed.end_date
      ? daysBetween(parsed.start_date, parsed.end_date)
      : null

  const baseRow = {
    project_id: parsed.project_id,
    parent_id: parsed.parent_id ?? null,
    kind: parsed.kind,
    title: parsed.title,
    description: parsed.description ?? null,
    start_date: nz(parsed.start_date),
    end_date: nz(parsed.end_date),
    due_date: nz(parsed.due_date),
    duration_days: duration,
    status: parsed.status,
    recurrence_rule: (parsed.recurrence_rule ?? null) as RecurrenceRule | null,
  }

  let id = parsed.id
  if (id) {
    const { error } = await supabase
      .from("schedule_items")
      .update(baseRow)
      .eq("id", id)
    if (error) {
      dbg("3:update_fail", error)
      throw new Error(error.message)
    }
    dbg("3:update_ok")
  } else {
    const { data, error } = await supabase
      .from("schedule_items")
      .insert(baseRow)
      .select("id")
      .single()
    if (error) {
      dbg("3:insert_fail", { code: error.code, msg: error.message, details: error.details, hint: error.hint })
      throw new Error(error.message)
    }
    id = data.id
    dbg("3:insert_ok", { id })
  }

  // Replace assignments. Track who is newly assigned so we can notify.
  const { data: oldAssignments, error: aSelErr } = await supabase
    .from("schedule_assignments")
    .select("profile_id, company_id")
    .eq("schedule_item_id", id)
  if (aSelErr) dbg("4:assignSelect_fail", aSelErr)
  const { error: aDelErr } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("schedule_item_id", id)
  if (aDelErr) {
    dbg("4:assignDelete_fail", aDelErr)
    throw new Error(aDelErr.message)
  }
  dbg("4:assignReset_ok")
  if (parsed.assignments.length) {
    const rows = parsed.assignments
      .filter((a) => a.profile_id || a.company_id)
      .map((a) => ({
        schedule_item_id: id!,
        profile_id: a.profile_id ?? null,
        company_id: a.company_id ?? null,
      }))
    if (rows.length) {
      const { error: assignErr } = await supabase
        .from("schedule_assignments")
        .insert(rows)
      if (assignErr) throw new Error(assignErr.message)

      // Notify newly-assigned profiles + companies (idempotent against re-saves)
      const oldKeys = new Set(
        (oldAssignments ?? []).map((a) => `${a.profile_id ?? ""}|${a.company_id ?? ""}`)
      )
      const newOnes = rows.filter(
        (r) => !oldKeys.has(`${r.profile_id ?? ""}|${r.company_id ?? ""}`)
      )
      if (newOnes.length) {
        await notifyScheduleAssignees(
          newOnes,
          parsed.project_id,
          id!,
          parsed.title
        )
      }
    }
  }

  // Replace checklist (for todos only)
  const { error: clDelErr } = await supabase
    .from("todo_checklist_items")
    .delete()
    .eq("schedule_item_id", id)
  if (clDelErr) {
    dbg("5:checklistDelete_fail", clDelErr)
    throw new Error(clDelErr.message)
  }
  dbg("5:checklistDelete_ok")
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
  // We always reconcile (parsed.predecessors may legitimately be empty,
  // meaning "clear all predecessors").
  {
    const { data: existing, error: pSelErr } = await supabase
      .from("schedule_predecessors")
      .select("item_id, predecessor_id, dep_type, lag_days, id, created_at")
      .or(`item_id.eq.${id},predecessor_id.eq.${id}`)
    if (pSelErr) {
      dbg("6:predSelect_fail", pSelErr)
      throw new Error(pSelErr.message)
    }
    dbg("6:predSelect_ok", { count: (existing ?? []).length })
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

  // Cascade to successors
  dbg("7:cascade_start")
  await applyCascade(parsed.project_id, id!)
  dbg("7:cascade_ok")

  revalidatePath(`/projects/${parsed.project_id}/schedule`)
  dbg("8:done")
  return { id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack ?? "" : ""
    console.error("[saveScheduleItem] CAUGHT:", msg, "\n", stack)
    throw e
  }
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

export async function deleteScheduleItem({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("schedule_items").delete().eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/schedule`)
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

export async function moveScheduleItem({
  id,
  project_id,
  start_date,
  end_date,
}: {
  id: string
  project_id: string
  start_date: string
  end_date: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .update({ start_date, end_date })
    .eq("id", id)
  if (error) throw new Error(error.message)
  await applyCascade(project_id, id)
  revalidatePath(`/projects/${project_id}/schedule`)
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
