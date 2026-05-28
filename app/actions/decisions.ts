"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"
import { addDays, todayISO } from "@/lib/utils"
import { sendEmail, appUrl } from "@/lib/email"
import { sendDashboardWebhook } from "@/lib/dashboard"
import type { TablesInsert, TablesUpdate } from "@/lib/db/types"

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
  // For per-choice photos on a selection, this is the choice's `client_key`
  // (matches Choice.client_key below). The server resolves it to a real UUID
  // after upserting choices. null/undefined means decision-level.
  choice_id: optStr,
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

const Choice = z.object({
  id: optStr,
  // Stable client-side key. For saved choices this equals `id`; for unsaved
  // ones it's a temporary value (e.g. "tmp-XYZ"). Per-choice attachments
  // reference choices by this key — see Attachment.choice_id above.
  client_key: z.string(),
  title: z.string().min(1),
  description: optStr,
  // For allowance selections: this is the absolute COST of the choice.
  // Otherwise: the delta to the contract. Can also be derived from cost_items
  // below × the parent decision's markup_percent — when both are present the
  // server recomputes from the breakdown and ignores the manual value.
  price_delta: z.coerce.number().nullish(),
  cost_items: z.array(CostItem).default([]),
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
    // Allowance fields — only meaningful for selections.
    allowance_amount: z.coerce.number().nullish(),
    allowance_cost_code_id: optStr,
    status: z.enum(["draft", "pending_client", "approved", "rejected"]).default("draft"),
    due_date: optStr,
    followups: z.array(Followup).default([]),
    attachments: z.array(Attachment).default([]),
    choices: z.array(Choice).default([]),
  })
  .passthrough()
  .superRefine((d, ctx) => {
    if (d.allowance_amount != null && d.kind !== "selection") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowances are only valid on selections.",
        path: ["allowance_amount"],
      })
    }
    if (d.allowance_cost_code_id && d.allowance_amount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set an allowance amount before picking a cost code.",
        path: ["allowance_cost_code_id"],
      })
    }
    // Per-choice cost breakdowns only make sense in the allowance flow —
    // a change_order with choices isn't a thing, and a selection without an
    // allowance uses the simpler manual per-choice price.
    const hasChoiceBreakdown = (d.choices ?? []).some(
      (c) => (c.cost_items ?? []).length > 0
    )
    if (hasChoiceBreakdown && d.allowance_amount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Per-choice cost breakdowns are only allowed when an allowance is set.",
        path: ["choices"],
      })
    }
  })

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

  // Allowance flow short-circuits the decision-level cost breakdown — pricing
  // comes from the selected choice's own line items / manual price. We still
  // compute a preview cost_delta on save (variance vs. allowance) so the
  // staff list shows a sensible estimate before the client approves; the
  // client_decide_decision RPC overwrites this on approval.
  const isAllowance =
    parsed.kind === "selection" && parsed.allowance_amount != null
  const allowanceAmount = isAllowance ? Number(parsed.allowance_amount) : null
  const allowanceCostCodeId = isAllowance
    ? nz(parsed.allowance_cost_code_id)
    : null

  // Compute the effective per-choice price (cost_items × markup → fallback to
  // manual). Memoized into a Map so both the cost_delta preview and the
  // decision_choices upsert below use the same numbers.
  const markupMul = 1 + parsed.markup_percent / 100
  const effectiveChoicePrice = new Map<string, number | null>()
  for (const c of parsed.choices) {
    if (c.cost_items.length > 0) {
      const choiceSubtotal = c.cost_items.reduce(
        (sum, ci) => sum + ci.quantity * ci.unit_cost,
        0
      )
      effectiveChoicePrice.set(
        c.client_key,
        round2(choiceSubtotal * markupMul)
      )
    } else {
      effectiveChoicePrice.set(
        c.client_key,
        c.price_delta == null ? null : Number(c.price_delta)
      )
    }
  }

  // Derive the client-facing cost_delta. Three paths:
  // 1. Allowance selection → variance of any currently-selected choice from
  //    the allowance. Until a client picks, the staff sees the manually-set
  //    cost_delta cleared (server-side recompute on approval).
  // 2. Decision-level cost_items present → marked-up total.
  // 3. Otherwise → fall back to the manual cost_delta value.
  const subtotal = parsed.cost_items.reduce(
    (sum, ci) => sum + ci.quantity * ci.unit_cost,
    0
  )
  let finalCostDelta: number | null
  if (isAllowance) {
    // If staff is editing an already-approved selection and the chosen
    // choice's price changed, recompute its variance so the pricing rollup
    // stays accurate. For draft/pending selections leave cost_delta null —
    // the RPC will fill it in when the client picks.
    finalCostDelta = null
    if (parsed.status === "approved" && parsed.id) {
      // Look up the selected_choice_id of the existing row so we can match it
      // against the in-flight choices. We already read prevStatus above; reuse
      // a focused query for the choice id.
      const { data: existing } = await supabase
        .from("decisions")
        .select("selected_choice_id")
        .eq("id", parsed.id)
        .maybeSingle()
      const selectedId = existing?.selected_choice_id ?? null
      if (selectedId) {
        const match = parsed.choices.find((c) => c.id === selectedId)
        if (match) {
          const price = effectiveChoicePrice.get(match.client_key) ?? 0
          finalCostDelta = round2(price - (allowanceAmount ?? 0))
        }
      }
    }
  } else if (parsed.cost_items.length > 0) {
    finalCostDelta = round2(subtotal * markupMul)
  } else {
    finalCostDelta = parsed.cost_delta ?? null
  }

  if (id) {
    const updateRow: TablesUpdate<"decisions"> = {
      project_id: parsed.project_id,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description ?? null,
      cost_delta: finalCostDelta,
      markup_percent: parsed.markup_percent,
      allowance_amount: allowanceAmount,
      allowance_cost_code_id: allowanceCostCodeId,
      status: parsed.status,
      due_date: nz(parsed.due_date),
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
          allowance_amount: allowanceAmount,
          allowance_cost_code_id: allowanceCostCodeId,
          status: parsed.status,
          due_date: nz(parsed.due_date),
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

  // Replace cost-item breakdown. Wipe-and-reinsert across both decision-level
  // (choice_id IS NULL) and per-choice (choice_id IS NOT NULL) rows — the
  // staff form is the source of truth for both.
  const { error: dciDelErr } = await supabase
    .from("decision_cost_items")
    .delete()
    .eq("decision_id", id)
  if (dciDelErr) throw new Error(dciDelErr.message)
  // Decision-level line items only make sense in the non-allowance flow; the
  // zod refinement above already rejects mixing them.
  if (!isAllowance && parsed.cost_items.length) {
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

  // Sync decision_choices (selections only — change orders ignore the list).
  // We use a reconcile-by-id pattern instead of wipe-and-reinsert because
  // `decisions.selected_choice_id` references these rows and clients may have
  // already picked one; recreating the rows would break the FK / orphan the
  // selected_choice_id.
  //
  // Returns a Map<client_key, real_uuid> so we can rewrite attachment
  // choice_id values from temporary "new:0" / "new:1" keys to real IDs.
  const choiceIdByClientKey = new Map<string, string>()
  if (parsed.kind === "selection") {
    const { data: existingChoices, error: existingChoicesErr } = await supabase
      .from("decision_choices")
      .select("id")
      .eq("decision_id", id)
    if (existingChoicesErr) throw new Error(existingChoicesErr.message)
    const keepChoiceIds = new Set(
      parsed.choices.map((c) => nz(c.id)).filter((x): x is string => !!x)
    )
    const choiceIdsToDelete = (existingChoices ?? [])
      .map((c) => c.id)
      .filter((cid) => !keepChoiceIds.has(cid))
    if (choiceIdsToDelete.length) {
      const { error: dchDelErr } = await supabase
        .from("decision_choices")
        .delete()
        .in("id", choiceIdsToDelete)
      if (dchDelErr) throw new Error(dchDelErr.message)
    }
    // Update existing + insert new, preserving the form's order via position.
    // We always seed `choiceIdByClientKey` so per-choice attachments resolve
    // correctly, regardless of whether the choice was new or already saved.
    for (let i = 0; i < parsed.choices.length; i++) {
      const c = parsed.choices[i]
      const cid = nz(c.id)
      // Effective price is what we computed from the choice's own cost_items
      // (× markup) or the manual value. Always write this so the DB matches
      // what the UI showed at save time.
      const choicePrice = effectiveChoicePrice.get(c.client_key) ?? null
      if (cid) {
        const { error: uErr } = await supabase
          .from("decision_choices")
          .update({
            title: c.title,
            description: c.description ?? null,
            price_delta: choicePrice,
            position: i,
          })
          .eq("id", cid)
          .eq("decision_id", id)
        if (uErr) throw new Error(uErr.message)
        choiceIdByClientKey.set(c.client_key, cid)
      } else {
        const { data: ins, error: iErr } = await supabase
          .from("decision_choices")
          .insert({
            decision_id: id!,
            title: c.title,
            description: c.description ?? null,
            price_delta: choicePrice,
            position: i,
          })
          .select("id")
          .single()
        if (iErr) throw new Error(iErr.message)
        if (ins) choiceIdByClientKey.set(c.client_key, ins.id)
      }
    }
    // Insert per-choice cost items now that we know each choice's real id.
    // Lines were already wiped above as part of the decision_cost_items
    // delete (the FK uses on delete cascade only when the parent choice is
    // dropped, but the explicit per-decision wipe also catches choice-scoped
    // rows). Only meaningful in the allowance flow.
    if (isAllowance) {
      const choiceRows: TablesInsert<"decision_cost_items">[] = []
      for (const c of parsed.choices) {
        const choiceId = choiceIdByClientKey.get(c.client_key)
        if (!choiceId) continue
        for (let j = 0; j < c.cost_items.length; j++) {
          const ci = c.cost_items[j]
          choiceRows.push({
            decision_id: id!,
            choice_id: choiceId,
            cost_code_id: nz(ci.cost_code_id),
            description: ci.description ?? null,
            quantity: ci.quantity,
            unit: ci.unit ?? null,
            unit_cost: ci.unit_cost,
            position: j,
          })
        }
      }
      if (choiceRows.length) {
        const { error: dciInsErr } = await supabase
          .from("decision_cost_items")
          .insert(choiceRows)
        if (dciInsErr) throw new Error(dciInsErr.message)
      }
    }
  } else {
    // Non-selection: clear any stale choices from a kind change.
    const { error: clearChoicesErr } = await supabase
      .from("decision_choices")
      .delete()
      .eq("decision_id", id)
    if (clearChoicesErr) throw new Error(clearChoicesErr.message)
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
  // Resolve a `client_key` (sent by the browser) to a real UUID. For saved
  // choices we set client_key === id in the loop above, so existing rows map
  // to themselves. Unknown keys (e.g. the choice was deleted in the same
  // save) become null — that attachment falls back to decision-level.
  const resolveChoiceId = (raw: string | null | undefined): string | null => {
    const v = nz(raw)
    if (!v) return null
    return choiceIdByClientKey.get(v) ?? null
  }

  const newOnes = parsed.attachments.filter((a) => !nz(a.id))
  if (newOnes.length) {
    const startPos = existingAtts?.length ?? 0
    const rows = newOnes.map((a, i) => ({
      decision_id: id!,
      choice_id: resolveChoiceId(a.choice_id),
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
      .update({
        caption: a.caption ?? null,
        choice_id: resolveChoiceId(a.choice_id),
      })
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

/**
 * Client-driven decide action. Wraps the SECURITY DEFINER RPC
 * `client_decide_decision`, which (a) flips the decision to approved /
 * rejected, (b) records the chosen selection option, and (c) materializes
 * the staff's follow-up to-do templates onto the schedule. The RPC itself
 * enforces that the caller is a client member of the project AND that the
 * decision is currently `pending_client` — keep this action thin.
 */
export async function clientDecideDecision({
  decision_id,
  project_id,
  action,
  choice_id,
}: {
  decision_id: string
  project_id: string
  action: "approve" | "decline"
  choice_id?: string | null
}) {
  await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.rpc("client_decide_decision", {
    p_decision_id: decision_id,
    p_action: action,
    p_choice_id: choice_id ?? undefined,
  })
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/decisions`)
  // Fire the same dashboard webhook the staff path uses when an approval
  // happens. Re-fetch the decision row so the webhook payload matches.
  const result = (data ?? {}) as {
    status?: string
    created_followups?: number
  }
  if (result.status === "approved") {
    const { data: decisionRow } = await supabase
      .from("decisions")
      .select("*")
      .eq("id", decision_id)
      .maybeSingle()
    if (decisionRow) {
      await sendDashboardWebhook("decision.approved", decisionRow)
    }
    if ((result.created_followups ?? 0) > 0) {
      revalidatePath(`/projects/${project_id}/schedule`)
    }
  }
  return result
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
