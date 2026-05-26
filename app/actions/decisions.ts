"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireSession, requireStaff } from "@/lib/auth"
import { addDays, formatCurrency, formatDate, todayISO } from "@/lib/utils"
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

const Choice = z.object({
  id: optStr,
  // Stable client-side key. For saved choices this equals `id`; for unsaved
  // ones it's a temporary value (e.g. "tmp-XYZ"). Per-choice attachments
  // reference choices by this key — see Attachment.choice_id above.
  client_key: z.string(),
  title: z.string().min(1),
  description: optStr,
  price_delta: z.coerce.number().nullish(),
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
    due_date: optStr,
    followups: z.array(Followup).default([]),
    attachments: z.array(Attachment).default([]),
    choices: z.array(Choice).default([]),
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
      if (cid) {
        const { error: uErr } = await supabase
          .from("decision_choices")
          .update({
            title: c.title,
            description: c.description ?? null,
            price_delta: c.price_delta ?? null,
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
            price_delta: c.price_delta ?? null,
            position: i,
          })
          .select("id")
          .single()
        if (iErr) throw new Error(iErr.message)
        if (ins) choiceIdByClientKey.set(c.client_key, ins.id)
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
    try {
      await notifyStaffOfApprovedDecision(id!)
    } catch (e) {
      console.warn("staff approved-decision email failed:", e)
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Email every staff user when a decision (selection or change order) is
 * approved. Uses the admin client to read the full decision detail because the
 * client-portal approval path runs under a client session that can't read
 * staff-only tables like decision_cost_items. Falls back gracefully when
 * RESEND or SERVICE_ROLE env vars are absent.
 */
async function notifyStaffOfApprovedDecision(decisionId: string) {
  const admin = createSupabaseAdminClient()
  if (!admin) return

  const { data: decision } = await admin
    .from("decisions")
    .select(
      `id, number, kind, title, description, cost_delta, markup_percent,
       status, due_date, approved_at, selected_choice_id,
       project_id, created_by, approved_by_client_id,
       projects:project_id (id, name, project_number, address),
       creator:created_by (full_name, email),
       client_approver:approved_by_client_id (full_name, email),
       decision_choices (id, title, description, price_delta, position),
       decision_cost_items (description, quantity, unit, unit_cost, position,
         cost_codes:cost_code_id (code, name)),
       decision_followup_templates (title, due_offset_days, notes, position,
         assignee:assignee_profile_id (full_name),
         company:assignee_company_id (name)),
       decision_attachments (file_name, caption)`
    )
    .eq("id", decisionId)
    .maybeSingle()
  if (!decision) return

  const { data: staff } = await admin
    .from("profiles")
    .select("email")
    .eq("role", "staff")
  const emails = (staff ?? [])
    .map((p) => p.email)
    .filter((e): e is string => !!e)
  if (!emails.length) return

  type Project = { name: string; project_number: string; address: string | null }
  type Choice = {
    id: string
    title: string
    description: string | null
    price_delta: number | null
    position: number
  }
  type CostItem = {
    description: string | null
    quantity: number
    unit: string | null
    unit_cost: number
    position: number
    cost_codes: { code: string; name: string } | null
  }
  type Followup = {
    title: string
    due_offset_days: number
    notes: string | null
    position: number
    assignee: { full_name: string | null } | null
    company: { name: string } | null
  }
  type Attachment = { file_name: string; caption: string | null }
  type Person = { full_name: string | null; email: string | null } | null

  const d = decision as unknown as {
    number: number
    kind: "selection" | "change_order"
    title: string
    description: string | null
    cost_delta: number | null
    markup_percent: number | null
    due_date: string | null
    approved_at: string | null
    selected_choice_id: string | null
    project_id: string
    projects: Project | null
    creator: Person
    client_approver: Person
    decision_choices: Choice[]
    decision_cost_items: CostItem[]
    decision_followup_templates: Followup[]
    decision_attachments: Attachment[]
  }

  const kindLabel = d.kind === "selection" ? "Selection" : "Change Order"
  const project = d.projects
  const projectLabel = project
    ? `${project.project_number} — ${project.name}`
    : "(unknown project)"
  const approver = d.client_approver?.full_name || d.client_approver?.email
    ? `${d.client_approver?.full_name ?? d.client_approver?.email} (client)`
    : "Staff"
  const creatorLabel =
    d.creator?.full_name || d.creator?.email || "(unknown)"

  const choices = [...d.decision_choices].sort((a, b) => a.position - b.position)
  const costItems = [...d.decision_cost_items].sort(
    (a, b) => a.position - b.position
  )
  const followups = [...d.decision_followup_templates].sort(
    (a, b) => a.position - b.position
  )

  const link = appUrl(`/projects/${d.project_id}/decisions`)

  const textLines: string[] = []
  textLines.push(`${kindLabel} #${d.number} approved`)
  textLines.push("")
  textLines.push(`Title:    ${d.title}`)
  textLines.push(`Project:  ${projectLabel}`)
  if (project?.address) textLines.push(`Address:  ${project.address}`)
  textLines.push(`Approved: ${formatDate(d.approved_at)} by ${approver}`)
  textLines.push(`Created by: ${creatorLabel}`)
  if (d.due_date) textLines.push(`Due date: ${formatDate(d.due_date)}`)
  textLines.push(`Cost impact: ${formatCurrency(d.cost_delta)}`)
  if (d.markup_percent && Number(d.markup_percent) !== 0) {
    textLines.push(`Markup: ${d.markup_percent}%`)
  }
  if (d.description) {
    textLines.push("")
    textLines.push("Description:")
    textLines.push(d.description)
  }
  if (d.kind === "selection" && choices.length) {
    textLines.push("")
    textLines.push("Choices:")
    for (const c of choices) {
      const tag = c.id === d.selected_choice_id ? " ← SELECTED" : ""
      const price = c.price_delta != null ? ` (${formatCurrency(c.price_delta)})` : ""
      textLines.push(`  - ${c.title}${price}${tag}`)
      if (c.description) textLines.push(`      ${c.description}`)
    }
  }
  if (costItems.length) {
    textLines.push("")
    textLines.push("Cost breakdown:")
    for (const ci of costItems) {
      const code = ci.cost_codes
        ? `[${ci.cost_codes.code} ${ci.cost_codes.name}] `
        : ""
      const lineTotal = ci.quantity * ci.unit_cost
      const unit = ci.unit ? ` ${ci.unit}` : ""
      textLines.push(
        `  - ${code}${ci.description ?? ""} — ${ci.quantity}${unit} × ${formatCurrency(
          ci.unit_cost
        )} = ${formatCurrency(lineTotal)}`
      )
    }
  }
  if (followups.length) {
    textLines.push("")
    textLines.push("Follow-up tasks:")
    for (const f of followups) {
      const who = f.assignee?.full_name ?? f.company?.name ?? "(unassigned)"
      textLines.push(
        `  - ${f.title} — assigned to ${who}, due +${f.due_offset_days}d`
      )
      if (f.notes) textLines.push(`      ${f.notes}`)
    }
  }
  if (d.decision_attachments.length) {
    textLines.push("")
    textLines.push("Attachments:")
    for (const a of d.decision_attachments) {
      const cap = a.caption ? ` — ${a.caption}` : ""
      textLines.push(`  - ${a.file_name}${cap}`)
    }
  }
  textLines.push("")
  textLines.push(`Open in app: ${link}`)
  const text = textLines.join("\n")

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(
      label
    )}</td><td style="padding:4px 0">${value}</td></tr>`

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:640px">`,
    `<h2 style="margin:0 0 4px">${escapeHtml(kindLabel)} #${d.number} approved</h2>`,
    `<p style="margin:0 0 16px;color:#555">${escapeHtml(d.title)}</p>`,
    `<table style="border-collapse:collapse;margin-bottom:16px">`,
    row("Project", escapeHtml(projectLabel)),
    project?.address ? row("Address", escapeHtml(project.address)) : "",
    row(
      "Approved",
      `${escapeHtml(formatDate(d.approved_at))} by ${escapeHtml(approver)}`
    ),
    row("Created by", escapeHtml(creatorLabel)),
    d.due_date ? row("Due date", escapeHtml(formatDate(d.due_date))) : "",
    row("Cost impact", escapeHtml(formatCurrency(d.cost_delta))),
    d.markup_percent && Number(d.markup_percent) !== 0
      ? row("Markup", `${escapeHtml(String(d.markup_percent))}%`)
      : "",
    `</table>`,
    d.description
      ? `<h3 style="margin:16px 0 4px;font-size:14px">Description</h3><div style="white-space:pre-wrap;color:#222">${escapeHtml(
          d.description
        )}</div>`
      : "",
    d.kind === "selection" && choices.length
      ? `<h3 style="margin:16px 0 4px;font-size:14px">Choices</h3><ul style="margin:0;padding-left:20px">${choices
          .map((c) => {
            const isSel = c.id === d.selected_choice_id
            const price =
              c.price_delta != null
                ? ` <span style="color:#555">(${escapeHtml(
                    formatCurrency(c.price_delta)
                  )})</span>`
                : ""
            const tag = isSel
              ? ` <strong style="color:#0a7d32">SELECTED</strong>`
              : ""
            const desc = c.description
              ? `<div style="color:#555;font-size:13px">${escapeHtml(
                  c.description
                )}</div>`
              : ""
            return `<li style="margin:4px 0">${escapeHtml(
              c.title
            )}${price}${tag}${desc}</li>`
          })
          .join("")}</ul>`
      : "",
    costItems.length
      ? `<h3 style="margin:16px 0 4px;font-size:14px">Cost breakdown</h3><table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr style="text-align:left;border-bottom:1px solid #ddd"><th style="padding:4px 8px 4px 0">Item</th><th style="padding:4px 8px;text-align:right">Qty</th><th style="padding:4px 8px;text-align:right">Unit cost</th><th style="padding:4px 0;text-align:right">Total</th></tr></thead><tbody>${costItems
          .map((ci) => {
            const code = ci.cost_codes
              ? `<span style="color:#888">[${escapeHtml(
                  ci.cost_codes.code
                )} ${escapeHtml(ci.cost_codes.name)}]</span> `
              : ""
            const lineTotal = ci.quantity * ci.unit_cost
            const unit = ci.unit ? ` ${escapeHtml(ci.unit)}` : ""
            return `<tr><td style="padding:4px 8px 4px 0">${code}${escapeHtml(
              ci.description ?? ""
            )}</td><td style="padding:4px 8px;text-align:right">${ci.quantity}${unit}</td><td style="padding:4px 8px;text-align:right">${escapeHtml(
              formatCurrency(ci.unit_cost)
            )}</td><td style="padding:4px 0;text-align:right">${escapeHtml(
              formatCurrency(lineTotal)
            )}</td></tr>`
          })
          .join("")}</tbody></table>`
      : "",
    followups.length
      ? `<h3 style="margin:16px 0 4px;font-size:14px">Follow-up tasks</h3><ul style="margin:0;padding-left:20px">${followups
          .map((f) => {
            const who = f.assignee?.full_name ?? f.company?.name ?? "(unassigned)"
            const notes = f.notes
              ? `<div style="color:#555;font-size:13px">${escapeHtml(
                  f.notes
                )}</div>`
              : ""
            return `<li style="margin:4px 0">${escapeHtml(
              f.title
            )} — <span style="color:#555">${escapeHtml(
              who
            )}, due +${f.due_offset_days}d</span>${notes}</li>`
          })
          .join("")}</ul>`
      : "",
    d.decision_attachments.length
      ? `<h3 style="margin:16px 0 4px;font-size:14px">Attachments</h3><ul style="margin:0;padding-left:20px">${d.decision_attachments
          .map((a) => {
            const cap = a.caption
              ? ` <span style="color:#555">— ${escapeHtml(a.caption)}</span>`
              : ""
            return `<li style="margin:2px 0">${escapeHtml(a.file_name)}${cap}</li>`
          })
          .join("")}</ul>`
      : "",
    `<p style="margin:20px 0 0"><a href="${link}" style="color:#1d4ed8">Open in app →</a></p>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("")

  await sendEmail({
    to: emails,
    subject: `${kindLabel} #${d.number} approved — ${d.title}`,
    text,
    html,
  })
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
    try {
      await notifyStaffOfApprovedDecision(decision_id)
    } catch (e) {
      console.warn("staff approved-decision email failed:", e)
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
