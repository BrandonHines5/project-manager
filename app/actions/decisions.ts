"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"
import { addDays, todayISO } from "@/lib/utils"
import { sendEmail, appUrl } from "@/lib/email"
import type { TablesUpdate } from "@/lib/db/types"

const Followup = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  assignee_profile_id: z.string().uuid().nullable().optional(),
  assignee_company_id: z.string().uuid().nullable().optional(),
  due_offset_days: z.number().int().min(0).default(7),
  notes: z.string().nullable().optional(),
})

const Attachment = z.object({
  id: z.string().uuid().optional(),
  storage_path: z.string(),
  file_name: z.string(),
  file_type: z.string().nullable().optional(),
  file_size: z.number().nullable().optional(),
  caption: z.string().nullable().optional(),
})

const DecisionInput = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  kind: z.enum(["change_order", "selection"]),
  title: z.string().min(1).max(300),
  description: z.string().nullable().optional(),
  cost_delta: z.coerce.number().nullable().optional(),
  status: z.enum(["draft", "pending_client", "approved", "rejected"]).default("draft"),
  followups: z.array(Followup).default([]),
  attachments: z.array(Attachment).default([]),
})

export type DecisionInputT = z.infer<typeof DecisionInput>

export async function saveDecision(input: DecisionInputT) {
  const profile = await requireStaff()
  const parsed = DecisionInput.parse(input)
  const supabase = await createSupabaseServerClient()

  let id = parsed.id
  const wasApproved = id
    ? (
        await supabase
          .from("decisions")
          .select("status")
          .eq("id", id)
          .maybeSingle()
      ).data?.status === "approved"
    : false

  const prevStatus = id
    ? (
        await supabase
          .from("decisions")
          .select("status")
          .eq("id", id)
          .maybeSingle()
      ).data?.status
    : null
  const newlyApproved = parsed.status === "approved" && !wasApproved
  const newlyPendingClient =
    parsed.status === "pending_client" && prevStatus !== "pending_client"

  if (id) {
    const updateRow: TablesUpdate<"decisions"> = {
      project_id: parsed.project_id,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description ?? null,
      cost_delta: parsed.cost_delta ?? null,
      status: parsed.status,
    }
    if (newlyApproved) updateRow.approved_at = new Date().toISOString()
    const { error } = await supabase
      .from("decisions")
      .update(updateRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    // Get next sequential number for this project
    const { data: maxRow } = await supabase
      .from("decisions")
      .select("number")
      .eq("project_id", parsed.project_id)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle()
    const number = (maxRow?.number ?? 0) + 1

    const { data, error } = await supabase
      .from("decisions")
      .insert({
        project_id: parsed.project_id,
        kind: parsed.kind,
        title: parsed.title,
        description: parsed.description ?? null,
        cost_delta: parsed.cost_delta ?? null,
        status: parsed.status,
        number,
        created_by: profile.id,
        approved_at:
          parsed.status === "approved" ? new Date().toISOString() : null,
      })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  // Replace follow-up templates
  await supabase
    .from("decision_followup_templates")
    .delete()
    .eq("decision_id", id)
  if (parsed.followups.length) {
    const rows = parsed.followups.map((f, i) => ({
      decision_id: id!,
      title: f.title,
      assignee_profile_id: f.assignee_profile_id ?? null,
      assignee_company_id: f.assignee_company_id ?? null,
      due_offset_days: f.due_offset_days,
      notes: f.notes ?? null,
      position: i,
    }))
    const { error } = await supabase
      .from("decision_followup_templates")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  // Reconcile attachments
  const { data: existingAtts } = await supabase
    .from("decision_attachments")
    .select("id, storage_path")
    .eq("decision_id", id)
  const keepIds = new Set(parsed.attachments.map((a) => a.id).filter(Boolean))
  const toDelete = (existingAtts ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    await supabase
      .from("decision_attachments")
      .delete()
      .in(
        "id",
        toDelete.map((d) => d.id)
      )
    await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
  }
  const newOnes = parsed.attachments.filter((a) => !a.id)
  if (newOnes.length) {
    const startPos = existingAtts?.length ?? 0
    const rows = newOnes.map((a, i) => ({
      decision_id: id!,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: a.file_type ?? null,
      file_size: a.file_size ?? null,
      caption: a.caption ?? null,
      position: startPos + i,
    }))
    const { error } = await supabase
      .from("decision_attachments")
      .insert(rows)
    if (error) throw new Error(error.message)
  }
  for (const a of parsed.attachments.filter((a) => a.id)) {
    await supabase
      .from("decision_attachments")
      .update({ caption: a.caption ?? null })
      .eq("id", a.id!)
  }

  // If this save transitions to approved, generate follow-up todos (once)
  let createdFollowups = 0
  if (newlyApproved) {
    createdFollowups = await materializeFollowups(id!, parsed.project_id)
  }

  if (newlyPendingClient) {
    try {
      await notifyClientOfDecision(id!, parsed.project_id, parsed.title)
    } catch (e) {
      console.warn("client decision email failed:", e)
    }
  }

  revalidatePath(`/projects/${parsed.project_id}/decisions`)
  if (createdFollowups > 0) {
    revalidatePath(`/projects/${parsed.project_id}/schedule`)
  }
  return { id, createdFollowups }
}

async function notifyClientOfDecision(
  decisionId: string,
  projectId: string,
  title: string
) {
  const supabase = await createSupabaseServerClient()
  const { data: clients } = await supabase
    .from("project_members")
    .select("profile_id, profiles!inner(email, role)")
    .eq("project_id", projectId)
  const emails: string[] = []
  for (const m of clients ?? []) {
    const prof = (m as unknown as { profiles: { email: string; role: string } })
      .profiles
    if (prof.role === "client" && prof.email) emails.push(prof.email)
  }
  if (!emails.length) return
  const link = appUrl(`/projects/${projectId}/decisions`)
  await sendEmail({
    to: emails,
    subject: `Approval needed: ${title}`,
    text: `A new item is awaiting your review on the project portal. Open: ${link}`,
  })
  void decisionId
}

async function materializeFollowups(decisionId: string, projectId: string) {
  const supabase = await createSupabaseServerClient()
  const { data: templates } = await supabase
    .from("decision_followup_templates")
    .select("*")
    .eq("decision_id", decisionId)
    .order("position", { ascending: true })

  if (!templates || templates.length === 0) return 0

  // Check what we've already created previously, to avoid duplicates on
  // re-approval.
  const { data: existing } = await supabase
    .from("schedule_items")
    .select("id, title")
    .eq("source_decision_id", decisionId)
  const existingTitles = new Set(existing?.map((e) => e.title) ?? [])

  const approvedDate = todayISO()
  const newTodos = templates
    .filter((t) => !existingTitles.has(t.title))
    .map((t) => ({
      project_id: projectId,
      kind: "todo" as const,
      title: t.title,
      description: t.notes,
      due_date: addDays(approvedDate, t.due_offset_days),
      source_decision_id: decisionId,
    }))
  if (newTodos.length === 0) return 0

  const { data: inserted, error } = await supabase
    .from("schedule_items")
    .insert(newTodos)
    .select("id, title")
  if (error) throw new Error(error.message)

  // Assignments
  const insertedByTitle = new Map((inserted ?? []).map((r) => [r.title, r.id]))
  const assignmentRows = templates
    .filter(
      (t) => insertedByTitle.has(t.title) && (t.assignee_profile_id || t.assignee_company_id)
    )
    .map((t) => ({
      schedule_item_id: insertedByTitle.get(t.title)!,
      profile_id: t.assignee_profile_id,
      company_id: t.assignee_company_id,
    }))
  if (assignmentRows.length) {
    await supabase.from("schedule_assignments").insert(assignmentRows)
  }

  // In-app notifications for staff assignees
  const profileAssignees = templates
    .filter((t) => t.assignee_profile_id && insertedByTitle.has(t.title))
    .map((t) => ({
      recipient_id: t.assignee_profile_id!,
      type: "decision_followup",
      title: `Follow-up: ${t.title}`,
      body: `Auto-created from an approved decision`,
      link_url: `/projects/${projectId}/schedule`,
    }))
  if (profileAssignees.length) {
    await supabase.from("notifications").insert(profileAssignees)
  }

  return inserted?.length ?? 0
}

export async function deleteDecision({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: atts } = await supabase
    .from("decision_attachments")
    .select("storage_path")
    .eq("decision_id", id)
  const paths = (atts ?? []).map((a) => a.storage_path)
  const { error } = await supabase.from("decisions").delete().eq("id", id)
  if (error) throw new Error(error.message)
  if (paths.length) {
    await supabase.storage.from("project-files").remove(paths)
  }
  revalidatePath(`/projects/${project_id}/decisions`)
}

export async function postComment({
  decision_id,
  project_id,
  body,
}: {
  decision_id: string
  project_id: string
  body: string
}) {
  const profile = await requireSession()
  if (!body.trim()) throw new Error("Comment is empty")
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("decision_comments").insert({
    decision_id,
    author_id: profile.id,
    body: body.trim(),
  })
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/decisions`)
}

export async function getSignedUrlsForDecisions(paths: string[]) {
  if (paths.length === 0) return {}
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
