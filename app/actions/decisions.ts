"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"
import { addDays, todayISO } from "@/lib/utils"
import { sendEmail, appUrl } from "@/lib/email"
import { sendDashboardWebhook } from "@/lib/dashboard"
import type { TablesUpdate } from "@/lib/db/types"

const optStr = z.string().nullish()

const Followup = z
  .object({
    id: optStr,
    title: z.string().min(1),
    assignee_profile_id: optStr,
    assignee_company_id: optStr,
    due_offset_days: z.coerce.number().int().min(0).default(7),
    notes: optStr,
  })
  .refine(
    (f) => Boolean(f.assignee_profile_id) !== Boolean(f.assignee_company_id),
    {
      message:
        "A follow-up must target exactly one: a profile (staff) OR a company (sub/vendor).",
      path: ["assignee_profile_id"],
    }
  )

const Attachment = z.object({
  id: optStr,
  storage_path: z.string(),
  file_name: z.string(),
  file_type: optStr,
  file_size: z.number().nullish(),
  caption: optStr,
})

const CostItem = z.object({
  id: optStr,
  cost_code_id: optStr,
  description: optStr,
  quantity: z.coerce.number().default(1),
  unit: optStr,
  unit_cost: z.coerce.number().default(0),
})

const DecisionInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    kind: z.enum(["change_order", "selection"]),
    title: z.string().min(1).max(300),
    description: optStr,
    // Manual cost (used when no line items exist). When line items exist,
    // cost_delta is recomputed server-side from line_total × markup and the
    // value the client sent is ignored.
    cost_delta: z.coerce.number().nullish(),
    markup_percent: z.coerce.number().default(0),
    cost_items: z.array(CostItem).default([]),
    status: z.enum(["draft", "pending_client", "approved", "rejected"]).default("draft"),
    followups: z.array(Followup).default([]),
    attachments: z.array(Attachment).default([]),
  })
  .passthrough()

export type DecisionInputT = z.infer<typeof DecisionInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export async function saveDecision(input: DecisionInputT) {
  const profile = await requireStaff()
  const result = DecisionInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  let id: string | null = nz(parsed.id)

  // Fetch current status + approved state ONCE (the duplicated query was the
  // earlier code path). Used to decide whether this save crosses an
  // approval / pending_client boundary.
  let prevStatus: string | null = null
  if (id) {
    const { data: cur } = await supabase
      .from("decisions")
      .select("status")
      .eq("id", id)
      .maybeSingle()
    prevStatus = cur?.status ?? null
  }
  const wasApproved = prevStatus === "approved"
  const newlyApproved = parsed.status === "approved" && !wasApproved
  const newlyPendingClient =
    parsed.status === "pending_client" && prevStatus !== "pending_client"

  // Derive the client-facing cost_delta. If the staff entered a cost
  // breakdown (any line item), the marked-up total takes precedence and the
  // manual `cost_delta` field they may also have typed is ignored. If they
  // entered no line items, fall back to the manual value as before.
  //
  // `markup_percent` is stored on the decision so re-opening the drawer
  // shows the same number — but the client never reads it.
  const subtotal = parsed.cost_items.reduce(
    (sum, ci) => sum + ci.quantity * ci.unit_cost,
    0
  )
  const finalCostDelta =
    parsed.cost_items.length > 0
      ? round2(subtotal * (1 + parsed.markup_percent / 100))
      : (parsed.cost_delta ?? null)

  if (id) {
    const updateRow: TablesUpdate<"decisions"> = {
      project_id: parsed.project_id,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description ?? null,
      cost_delta: finalCostDelta,
      markup_percent: parsed.markup_percent,
      status: parsed.status,
    }
    if (newlyApproved) updateRow.approved_at = new Date().toISOString()
    const { error } = await supabase
      .from("decisions")
      .update(updateRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    // Race-safe per-project number: call the advisory-locked RPC to pick the
    // next number, then INSERT. Retry on a 23505 unique violation (someone
    // else won the race in the gap between RPC and INSERT — rare with the
    // advisory lock, but possible across separate transactions).
    let inserted: { id: string } | null = null
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { data: nextNum, error: rpcErr } = await supabase.rpc(
        "next_decision_number",
        { p_project: parsed.project_id }
      )
      if (rpcErr) throw new Error(rpcErr.message)
      const number = Number(nextNum)
      const { data, error } = await supabase
        .from("decisions")
        .insert({
          project_id: parsed.project_id,
          kind: parsed.kind,
          title: parsed.title,
          description: parsed.description ?? null,
          cost_delta: finalCostDelta,
          markup_percent: parsed.markup_percent,
          status: parsed.status,
          number,
          created_by: profile.id,
          approved_at:
            parsed.status === "approved" ? new Date().toISOString() : null,
        })
        .select("id")
        .single()
      if (!error) {
        inserted = data
        break
      }
      if (error.code !== "23505") throw new Error(error.message)
      // brief backoff before retry
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
    }
    if (!inserted) {
      throw new Error("Could not allocate a decision number after 5 attempts.")
    }
    id = inserted.id
  }

  // Replace cost-item breakdown. Same delete-then-insert pattern as
  // follow-ups — line items are append-only from the staff's perspective and
  // rarely re-ordered, so a wipe-and-reinsert is the simplest correct sync.
  // Capture the delete error: if it fails and we then insert, the decision
  // would end up with stale + new rows for the same line numbers.
  const { error: dciDelErr } = await supabase
    .from("decision_cost_items")
    .delete()
    .eq("decision_id", id)
  if (dciDelErr) throw new Error(dciDelErr.message)
  if (parsed.cost_items.length) {
    const rows = parsed.cost_items.map((ci, i) => ({
      decision_id: id!,
      cost_code_id: nz(ci.cost_code_id),
      description: ci.description ?? null,
      quantity: ci.quantity,
      unit: ci.unit ?? null,
      unit_cost: ci.unit_cost,
      position: i,
    }))
    const { error } = await supabase.from("decision_cost_items").insert(rows)
    if (error) throw new Error(error.message)
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
  const keepIds = new Set(
    parsed.attachments.map((a) => nz(a.id)).filter((x): x is string => !!x)
  )
  const toDelete = (existingAtts ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    const { error: rmErr } = await supabase
      .from("decision_attachments")
      .delete()
      .in(
        "id",
        toDelete.map((d) => d.id)
      )
    if (rmErr) throw new Error(rmErr.message)
    // Storage cleanup is best-effort — failing to remove the blob shouldn't
    // block the user from saving (the row is already gone). Log instead.
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
    if (storageErr) {
      console.warn(
        "[saveDecision] storage cleanup failed (non-fatal):",
        storageErr.message
      )
    }
  }
  const newOnes = parsed.attachments.filter((a) => !nz(a.id))
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
  for (const a of parsed.attachments.filter((a) => nz(a.id))) {
    const { error: capErr } = await supabase
      .from("decision_attachments")
      .update({ caption: a.caption ?? null })
      .eq("id", a.id!)
      // Defense in depth: only touch attachments owned by this decision.
      .eq("decision_id", id)
    if (capErr) throw new Error(capErr.message)
  }

  // Materialize follow-ups whenever the decision is in 'approved' state.
  // The function is idempotent — already-materialized templates are skipped
  // by template-id match. This means staff can add new templates to an
  // already-approved decision and they'll be created on the next save.
  let createdFollowups = 0
  if (parsed.status === "approved") {
    createdFollowups = await materializeFollowups(
      id!,
      parsed.project_id,
      profile.id
    )
  }

  // Notify the dashboard ONCE per approval (not on every re-save of an
  // already-approved decision). The dashboard mirrors approved decisions
  // into the client's progress view.
  if (newlyApproved) {
    const { data: decisionRow } = await supabase
      .from("decisions")
      .select("*")
      .eq("id", id!)
      .maybeSingle()
    if (decisionRow) {
      await sendDashboardWebhook("decision.approved", decisionRow)
    }
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

async function materializeFollowups(
  decisionId: string,
  projectId: string,
  createdBy: string
) {
  const supabase = await createSupabaseServerClient()
  const { data: templates } = await supabase
    .from("decision_followup_templates")
    .select("*")
    .eq("decision_id", decisionId)
    .order("position", { ascending: true })

  if (!templates || templates.length === 0) return 0

  // Track which TEMPLATE has already been materialized via a sentinel in
  // schedule_items.description (a JSON tail). Templates are matched by their
  // own UUID, not by title — so duplicate titles materialize separately and
  // each assignment lands on the right row.
  const TEMPLATE_TAG = (templateId: string) => `\n[followup_template:${templateId}]`

  const { data: existing } = await supabase
    .from("schedule_items")
    .select("id, description")
    .eq("source_decision_id", decisionId)
  const materializedTemplateIds = new Set<string>()
  for (const row of existing ?? []) {
    const match = (row.description ?? "").match(/\[followup_template:([^\]]+)\]/)
    if (match) materializedTemplateIds.add(match[1])
  }

  const approvedDate = todayISO()
  const newTemplates = templates.filter((t) => !materializedTemplateIds.has(t.id))
  if (newTemplates.length === 0) return 0

  // We insert one schedule_item per template and tag it so we can match
  // assignments + notifications back deterministically.
  const newTodos = newTemplates.map((t) => ({
    project_id: projectId,
    kind: "todo" as const,
    title: t.title,
    description: (t.notes ?? "") + TEMPLATE_TAG(t.id),
    due_date: addDays(approvedDate, t.due_offset_days),
    source_decision_id: decisionId,
    created_by: createdBy,
  }))

  const { data: inserted, error } = await supabase
    .from("schedule_items")
    .insert(newTodos)
    .select("id, description")
  if (error) throw new Error(error.message)

  // Map inserted schedule_items back to the original templates by parsing
  // the tag. This is robust against duplicate titles, identical descriptions,
  // and inserts whose ordering the DB chose not to preserve.
  const idByTemplateId = new Map<string, string>()
  for (const row of inserted ?? []) {
    const m = (row.description ?? "").match(/\[followup_template:([^\]]+)\]/)
    if (m) idByTemplateId.set(m[1], row.id)
  }

  const assignmentRows = newTemplates
    .filter(
      (t) =>
        idByTemplateId.has(t.id) &&
        (t.assignee_profile_id || t.assignee_company_id)
    )
    .map((t) => ({
      schedule_item_id: idByTemplateId.get(t.id)!,
      profile_id: t.assignee_profile_id,
      company_id: t.assignee_company_id,
    }))
  if (assignmentRows.length) {
    const { error: aErr } = await supabase
      .from("schedule_assignments")
      .insert(assignmentRows)
    if (aErr) console.warn("[followup assignments insert]", aErr.message)
  }

  const profileAssignees = newTemplates
    .filter((t) => t.assignee_profile_id && idByTemplateId.has(t.id))
    .map((t) => ({
      recipient_id: t.assignee_profile_id!,
      type: "decision_followup",
      title: `Follow-up: ${t.title}`,
      body: "Auto-created from an approved decision",
      link_url: `/projects/${projectId}/schedule`,
    }))
  if (profileAssignees.length) {
    const { error: nErr } = await supabase
      .from("notifications")
      .insert(profileAssignees)
    if (nErr) console.warn("[followup notifications insert]", nErr.message)
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
