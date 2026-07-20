"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireSession, requireStaff } from "@/lib/auth"
import { getActiveOrgId } from "@/lib/org"
import { assertActiveOrgWritable } from "@/lib/sandbox"
import { addDays, formatCurrency, formatDate, todayISO } from "@/lib/utils"
import { sendEmail, appUrl } from "@/lib/email"
import { isChannelEnabled } from "@/lib/notifications/preferences"
import { sendDashboardWebhook } from "@/lib/dashboard"
import { notifyCommentPosted } from "@/lib/comms/notify"
import type { TablesInsert, TablesUpdate } from "@/lib/db/types"
import { normalizeTag } from "@/lib/template-tags"

const optStr = z.string().nullish()

const Followup = z
  .object({
    id: optStr,
    title: z.string().min(1),
    // 'todo' (default) or 'work' — a follow-up can now materialize a work
    // bar on the schedule, not just a to-do.
    kind: z.enum(["todo", "work"]).default("todo"),
    assignee_profile_id: optStr,
    assignee_company_id: optStr,
    // Fixed offset from the approval date. For a to-do it's the due date; for
    // a work item it's the start date. Ignored when anchored to a schedule item.
    due_offset_days: z.coerce.number().int().min(0).default(7),
    // Work-item length (days). Ignored for to-dos.
    duration_days: z.coerce.number().int().min(1).nullish(),
    // Optional anchor to an existing schedule item: due/start date is computed
    // from the anchor's start or end date + a signed offset. All three travel
    // together or none of them do (enforced/normalized in saveDecision).
    anchor_schedule_item_id: optStr,
    parent_anchor: z.enum(["start", "end"]).nullish(),
    parent_offset_days: z.coerce.number().int().nullish(),
    notes: optStr,
  })
  // A follow-up targets at most one assignee. Both-set is a programming error;
  // none-set is allowed (an unassigned follow-up just lands on the schedule).
  .refine((f) => !(f.assignee_profile_id && f.assignee_company_id), {
    message:
      "A follow-up can target at most one: a profile (staff) OR a company (sub/vendor), not both.",
    path: ["assignee_profile_id"],
  })

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
  // Optional link to the HH-SpecMagician item catalog (separate Supabase
  // project — bare uuid, no FK; see migration 0076). The code is a display
  // snapshot captured when the staffer picks the item.
  catalog_item_id: optStr,
  catalog_item_code: optStr,
})

// A decision assignment targets exactly one of a person / company / role
// (mirrors schedule_assignments — DB CHECK enforces it; rows failing the
// one-of rule are dropped in saveDecision rather than failing the save).
const DecisionAssignment = z.object({
  profile_id: optStr,
  company_id: optStr,
  role_id: optStr,
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
    // Schedule impact — change orders only. delay_days is required there
    // (0 = no delay); delay_days × delay_cost_per_day is folded into
    // cost_delta so the client sees one all-in price.
    delay_days: z.coerce.number().int().min(0).nullish(),
    delay_cost_per_day: z.coerce.number().min(0).nullish(),
    // Allowance fields — only meaningful for selections.
    allowance_amount: z.coerce.number().nullish(),
    allowance_cost_code_id: optStr,
    status: z.enum(["draft", "pending_client", "approved", "rejected"]).default("draft"),
    due_date: optStr,
    // Optional link tying due_date to a schedule item (start/end ± offset).
    // All three travel together or none of them do (normalized below, and
    // enforced by the decisions_due_anchor_triple_chk constraint). When
    // linked, due_date is computed server-side from the item's current dates
    // and a DB trigger keeps it fresh as the item moves.
    due_anchor_schedule_item_id: optStr,
    due_anchor: z.enum(["start", "end"]).nullish(),
    due_anchor_offset_days: z.coerce.number().int().nullish(),
    // Smart-template conditions (e.g. ["walkout"]). Optional so callers
    // that don't send the field leave the stored value untouched.
    template_tags: z.array(z.string()).optional(),
    followups: z.array(Followup).default([]),
    attachments: z.array(Attachment).default([]),
    choices: z.array(Choice).default([]),
    // Selections only: the client_key of the choice staff is approving on the
    // client's behalf. Lets a staff-direct approval record which option was
    // chosen (and bill its cost) without the client having picked through the
    // portal. A saved choice's client_key equals its id. Ignored unless the
    // save transitions to `approved`; unset means "auto-select if there's
    // exactly one choice, else keep the client's existing pick".
    selected_choice_key: optStr,
    // People / companies / roles this decision is assigned to (selections —
    // lets subs see the selections they're on; migration 0075).
    assignments: z.array(DecisionAssignment).default([]),
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
    // Decision-level cost breakdowns are change-order-only. Selections capture
    // cost on each choice (the client picks one and its price flows through).
    if (d.kind === "selection" && d.cost_items.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Selections track cost per choice — use the per-choice breakdown instead of a decision-level one.",
        path: ["cost_items"],
      })
    }
    // Per-choice cost breakdowns only make sense on selections (change orders
    // have no choices).
    const hasChoiceBreakdown = (d.choices ?? []).some(
      (c) => (c.cost_items ?? []).length > 0
    )
    if (hasChoiceBreakdown && d.kind !== "selection") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Per-choice cost breakdowns are only valid on selections.",
        path: ["choices"],
      })
    }
    // Every change order must quote its schedule impact (0 = no delay), and a
    // non-zero delay needs a per-day cost so the total is computable.
    if (d.kind === "change_order") {
      if (d.delay_days == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Delay (days) is required on change orders — enter 0 for no delay.",
          path: ["delay_days"],
        })
      } else if (d.delay_days > 0 && d.delay_cost_per_day == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter the cost per day of delay.",
          path: ["delay_cost_per_day"],
        })
      }
    } else if (d.delay_days != null || d.delay_cost_per_day != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Delay fields are only valid on change orders.",
        path: ["delay_days"],
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
  await assertActiveOrgWritable()
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

  // Selections capture cost on each choice; the chosen choice's price (minus
  // the allowance, if any) becomes cost_delta on approval. Change orders use
  // the decision-level breakdown.
  const isSelection = parsed.kind === "selection"
  const isAllowance = isSelection && parsed.allowance_amount != null
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

  // Schedule-impact cost — change orders only (zod guarantees delay_days is
  // set there). Folded into cost_delta below so the client sees one all-in
  // price and every cost_delta consumer (pricing rollup, dashboard webhook)
  // includes it for free.
  const delayCost =
    parsed.kind === "change_order"
      ? round2((parsed.delay_days ?? 0) * (parsed.delay_cost_per_day ?? 0))
      : 0

  // Derive the client-facing cost_delta:
  // - Selection: the chosen choice's price (minus allowance, if set) becomes
  //   cost_delta on approval. The choice can be picked by the client (the
  //   client_decide RPC sets selected_choice_id) OR, on a staff-direct
  //   approval, designated by staff / auto-selected when there's exactly one
  //   choice. We resolve the chosen choice's client_key here — prices are
  //   keyed by client_key and available before the upsert — so cost_delta
  //   lands immediately; selected_choice_id itself is written AFTER the choice
  //   upsert (below), once any brand-new choice has a real id.
  // - Change order: marked-up total from decision-level cost_items if any,
  //   else the manual cost_delta value — plus the delay cost either way.
  let finalCostDelta: number | null
  // Selections: client_key of the choice being approved (resolved to a real
  // choice id post-upsert). Stays null when nothing is picked yet.
  let approvedChoiceKey: string | null = null
  if (isSelection) {
    finalCostDelta = null
    if (parsed.status === "approved") {
      // Prior selection state — a client may already have picked, and legacy
      // choices with no recorded price fall back to the stored cost_delta.
      let existingSelectedId: string | null = null
      let existingCostDelta: number | null = null
      if (parsed.id) {
        const { data: existing } = await supabase
          .from("decisions")
          .select("selected_choice_id, cost_delta")
          .eq("id", parsed.id)
          .maybeSingle()
        existingSelectedId = existing?.selected_choice_id ?? null
        existingCostDelta = existing?.cost_delta ?? null
      }
      // Which choice is being approved? Priority:
      //   1. Staff's explicit pick (client_key sent from the drawer)
      //   2. The choice the client already picked (existing selected_choice_id),
      //      as long as it still exists in the form
      //   3. Auto-select when the selection offers exactly one choice
      const explicitKey = nz(parsed.selected_choice_key)
      const existingMatch = existingSelectedId
        ? parsed.choices.find((c) => c.id === existingSelectedId)
        : undefined
      if (explicitKey && parsed.choices.some((c) => c.client_key === explicitKey)) {
        approvedChoiceKey = explicitKey
      } else if (existingMatch) {
        approvedChoiceKey = existingMatch.client_key
      } else if (parsed.choices.length === 1) {
        approvedChoiceKey = parsed.choices[0].client_key
      }
      if (approvedChoiceKey) {
        // A missing price (legacy data from before per-choice costs) preserves
        // the existing cost_delta rather than treating it as zero.
        const price = effectiveChoicePrice.get(approvedChoiceKey) ?? null
        finalCostDelta =
          price == null
            ? existingCostDelta
            : round2(price - (allowanceAmount ?? 0))
      } else {
        finalCostDelta = existingCostDelta
      }
    }
  } else if (parsed.cost_items.length > 0) {
    const subtotal = parsed.cost_items.reduce(
      (sum, ci) => sum + ci.quantity * ci.unit_cost,
      0
    )
    finalCostDelta = round2(subtotal * markupMul + delayCost)
  } else {
    // Manual mode: the staff-entered value is the base price EXCLUDING delay
    // (the drawer derives it back out of cost_delta when re-editing). A
    // pure-delay change order (no base price) still gets a real total.
    finalCostDelta =
      parsed.cost_delta != null
        ? round2(Number(parsed.cost_delta) + delayCost)
        : delayCost !== 0
        ? delayCost
        : null
  }

  // Resolve the due-date link. When the anchor triple is present, the due
  // date is derived from the schedule item's current start/end — the fixed
  // date the browser sent (if any) is ignored so the stored due_date can
  // never drift from the recipe. The item is re-read under the caller's RLS
  // session and must belong to this project.
  const dueAnchorId = nz(parsed.due_anchor_schedule_item_id)
  const dueLinked =
    !!dueAnchorId && !!parsed.due_anchor && parsed.due_anchor_offset_days != null
  const dueAnchor = dueLinked ? parsed.due_anchor! : null
  const dueAnchorOffset = dueLinked
    ? Math.trunc(parsed.due_anchor_offset_days!)
    : null
  let finalDueDate = nz(parsed.due_date)
  if (dueLinked) {
    const { data: anchorItem, error: anchorErr } = await supabase
      .from("schedule_items")
      .select("id, project_id, start_date, end_date")
      .eq("id", dueAnchorId)
      .maybeSingle()
    if (anchorErr) throw new Error(anchorErr.message)
    if (!anchorItem || anchorItem.project_id !== parsed.project_id) {
      throw new Error(
        "The schedule item linked to the due date wasn't found in this project."
      )
    }
    const basis =
      dueAnchor === "start" ? anchorItem.start_date : anchorItem.end_date
    finalDueDate = basis ? addDays(basis, dueAnchorOffset!) : null
  }

  // Only touch template_tags when the caller sent them — undefined means
  // "not editing tags in this save".
  const normalizedTags =
    parsed.template_tags !== undefined
      ? parsed.template_tags
          .map(normalizeTag)
          .filter((t, i, arr) => t !== "" && arr.indexOf(t) === i)
      : undefined

  if (id) {
    const updateRow: TablesUpdate<"decisions"> = {
      project_id: parsed.project_id,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description ?? null,
      cost_delta: finalCostDelta,
      markup_percent: parsed.markup_percent,
      delay_days: parsed.kind === "change_order" ? parsed.delay_days ?? null : null,
      delay_cost_per_day:
        parsed.kind === "change_order" ? parsed.delay_cost_per_day ?? null : null,
      allowance_amount: allowanceAmount,
      allowance_cost_code_id: allowanceCostCodeId,
      status: parsed.status,
      due_date: finalDueDate,
      due_anchor_schedule_item_id: dueLinked ? dueAnchorId : null,
      due_anchor: dueAnchor,
      due_anchor_offset_days: dueAnchorOffset,
    }
    if (normalizedTags !== undefined) updateRow.template_tags = normalizedTags
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
          delay_days:
            parsed.kind === "change_order" ? parsed.delay_days ?? null : null,
          delay_cost_per_day:
            parsed.kind === "change_order" ? parsed.delay_cost_per_day ?? null : null,
          allowance_amount: allowanceAmount,
          allowance_cost_code_id: allowanceCostCodeId,
          status: parsed.status,
          due_date: finalDueDate,
          due_anchor_schedule_item_id: dueLinked ? dueAnchorId : null,
          due_anchor: dueAnchor,
          due_anchor_offset_days: dueAnchorOffset,
          template_tags: normalizedTags ?? [],
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
  // Decision-level line items are change-order-only — selections capture
  // cost per choice. The zod refinement above already rejects mixing them.
  if (!isSelection && parsed.cost_items.length) {
    const rows = parsed.cost_items.map((ci, i) => ({
      decision_id: id!,
      cost_code_id: nz(ci.cost_code_id),
      description: ci.description ?? null,
      quantity: ci.quantity,
      unit: ci.unit ?? null,
      unit_cost: ci.unit_cost,
      catalog_item_id: nz(ci.catalog_item_id),
      catalog_item_code: nz(ci.catalog_item_code),
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
    // rows). Available for any selection — each choice can itemize its own
    // cost, and with an allowance the variance is what flows to billing.
    {
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
            catalog_item_id: nz(ci.catalog_item_id),
            catalog_item_code: nz(ci.catalog_item_code),
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
    // Record the approved choice (staff pick or auto-selected lone choice) now
    // that every choice has a real id. The pricing rollup keys off cost_delta
    // (written in the decision update above) and the drawer's "Chosen" badge
    // off selected_choice_id. Only on approval — the draft/pending flow leaves
    // the client's own pick untouched.
    if (parsed.status === "approved" && approvedChoiceKey) {
      const resolvedChoiceId = choiceIdByClientKey.get(approvedChoiceKey) ?? null
      if (resolvedChoiceId) {
        const { error: selErr } = await supabase
          .from("decisions")
          .update({ selected_choice_id: resolvedChoiceId })
          .eq("id", id)
        if (selErr) throw new Error(selErr.message)
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
    const rows = parsed.followups.map((f, i) => {
      // The anchor triple is all-or-nothing — match the DB check constraint
      // and the schedule_items anchoring convention.
      const anchorId = nz(f.anchor_schedule_item_id)
      const anchored =
        !!anchorId && !!f.parent_anchor && f.parent_offset_days != null
      return {
        decision_id: id!,
        title: f.title,
        kind: f.kind,
        assignee_profile_id: f.assignee_profile_id ?? null,
        assignee_company_id: f.assignee_company_id ?? null,
        due_offset_days: f.due_offset_days,
        duration_days: f.kind === "work" ? f.duration_days ?? 1 : null,
        anchor_schedule_item_id: anchored ? anchorId : null,
        parent_anchor: anchored ? f.parent_anchor : null,
        parent_offset_days: anchored ? Math.trunc(f.parent_offset_days!) : null,
        notes: f.notes ?? null,
        position: i,
      }
    })
    const { error } = await supabase
      .from("decision_followup_templates")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  // Replace decision assignments (people / companies / roles — lets subs see
  // the selections they're on, migration 0075). Wipe-and-reinsert like
  // followups; the staff form is the source of truth. Reads the prior rows
  // first so newly-added staff assignees get an in-app notification.
  {
    const { data: prevAssignments } = await supabase
      .from("decision_assignments")
      .select("profile_id")
      .eq("decision_id", id)
    const prevProfiles = new Set(
      (prevAssignments ?? []).map((a) => a.profile_id).filter(Boolean)
    )
    const { error: dassDelErr } = await supabase
      .from("decision_assignments")
      .delete()
      .eq("decision_id", id)
    if (dassDelErr) throw new Error(dassDelErr.message)

    const seen = new Set<string>()
    // Selections only — mirrors the client-side gate and the non-selection
    // choices cleanup above, so a create-mode kind switch can't persist
    // invisible assignment rows (which would grant trades RLS read) on a
    // change order.
    const sourceAssignments =
      parsed.kind === "selection" ? parsed.assignments : []
    const assignmentRows = sourceAssignments
      .map((a) => ({
        profile_id: nz(a.profile_id),
        company_id: nz(a.company_id),
        role_id: nz(a.role_id),
      }))
      .filter(
        (a) =>
          [a.profile_id, a.company_id, a.role_id].filter(Boolean).length === 1
      )
      .filter((a) => {
        const k = `${a.profile_id}|${a.company_id}|${a.role_id}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .map((a) => ({ decision_id: id!, ...a }))
    if (assignmentRows.length) {
      const { error: dassInsErr } = await supabase
        .from("decision_assignments")
        .insert(assignmentRows)
      if (dassInsErr) throw new Error(dassInsErr.message)

      // Best-effort in-app notification for newly-added staff assignees.
      const newProfiles = assignmentRows
        .map((a) => a.profile_id)
        .filter((p): p is string => !!p && !prevProfiles.has(p))
      if (newProfiles.length) {
        const { error: notifErr } = await supabase.from("notifications").insert(
          newProfiles.map((p) => ({
            recipient_id: p,
            type: "decision_assignment",
            title: `Assigned: ${parsed.title}`,
            body: `You were assigned to a ${parsed.kind === "selection" ? "selection" : "change order"}`,
            link_url: `/projects/${parsed.project_id}/decisions?open=${id}`,
          }))
        )
        if (notifErr) {
          console.warn(
            "[saveDecision] assignment notification failed:",
            notifErr.message
          )
        }
      }
    }
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
      // Gate the dashboard webhook on the PROJECT's org, not the actor's
      // active org — a multi-org staffer could be acting on a project outside
      // their selected org, and this best-effort lookup must never fail the
      // already-saved decision.
      const { data: proj } = await supabase
        .from("projects")
        .select("org_id")
        .eq("id", decisionRow.project_id)
        .maybeSingle()
      await sendDashboardWebhook(
        "decision.approved",
        decisionRow,
        proj?.org_id ?? null
      )
    }
    try {
      await notifyStaffOfApprovedDecision(id!)
    } catch (e) {
      console.warn("staff approved-decision email failed:", e)
    }
  }

  if (newlyPendingClient) {
    try {
      await notifyClientOfDecision(id!, parsed.project_id, parsed.title, profile.id)
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
  title: string,
  senderProfileId?: string
) {
  const supabase = await createSupabaseServerClient()
  const { data: clients } = await supabase
    .from("project_members")
    .select("profile_id, profiles!inner(full_name, email, role, notifications_enabled)")
    .eq("project_id", projectId)
  // One send per client (not a single multi-recipient email) so each
  // Communications row carries the client's profile_id — that's what lets
  // the client see their own row under RLS.
  const recipients: { profile_id: string; email: string; name: string | null }[] = []
  for (const m of clients ?? []) {
    const prof = (
      m as unknown as {
        profiles: {
          full_name: string | null
          email: string
          role: string
          notifications_enabled: boolean
        }
      }
    ).profiles
    if (
      prof.role === "client" &&
      prof.email &&
      prof.notifications_enabled &&
      (await isChannelEnabled(
        supabase,
        { profileId: m.profile_id },
        "client_decisions",
        "email"
      ))
    )
      recipients.push({
        profile_id: m.profile_id,
        email: prof.email,
        name: prof.full_name,
      })
  }
  if (!recipients.length) return
  const link = appUrl(`/projects/${projectId}/decisions?open=${decisionId}`)
  await Promise.all(
    recipients.map((r) =>
      sendEmail({
        to: [r.email],
        subject: `Approval needed: ${title}`,
        text: `A new item is awaiting your review on the project portal. Open: ${link}`,
        log: {
          project_id: projectId,
          profile_id: r.profile_id,
          sent_by: senderProfileId ?? null,
          kind: "decision_notify",
          counterparty_name: r.name,
        },
      }).catch((e) => console.warn("[notifyClientOfDecision] email failed:", e))
    )
  )
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
  if (!admin) {
    console.warn(
      "[approved-decision email] skipped — admin client unavailable (SUPABASE_SERVICE_ROLE_KEY unset)"
    )
    return
  }

  // Disambiguate decision_choices: there are TWO relationships between
  // decisions and decision_choices (the choices list via
  // decision_choices.decision_id, and the chosen one via
  // decisions.selected_choice_id). Without the explicit FK hint PostgREST
  // raises PGRST201 and the whole query returns null — which previously made
  // this email silently never send. Capture the error too so a future schema
  // change can't re-hide it.
  const { data: decision, error: decisionErr } = await admin
    .from("decisions")
    .select(
      `id, number, kind, title, description, cost_delta, markup_percent,
       delay_days, delay_cost_per_day,
       status, due_date, approved_at, selected_choice_id,
       project_id, created_by, approved_by_client_id,
       projects:project_id (id, name, project_number, address),
       creator:created_by (full_name, email),
       client_approver:approved_by_client_id (full_name, email),
       decision_choices!decision_choices_decision_id_fkey (id, title, description, price_delta, position),
       decision_cost_items (description, quantity, unit, unit_cost, position,
         cost_codes:cost_code_id (code, name)),
       decision_followup_templates!decision_followup_templates_decision_id_fkey (title, due_offset_days, notes, position,
         assignee:assignee_profile_id (full_name),
         company:assignee_company_id (name)),
       decision_attachments (file_name, caption)`
    )
    .eq("id", decisionId)
    .maybeSingle()
  if (decisionErr) {
    console.warn(
      "[approved-decision email] decision query failed:",
      decisionErr.message
    )
    return
  }
  if (!decision) return

  const { data: staff } = await admin
    .from("profiles")
    .select("id, email")
    .eq("role", "staff")
    .eq("notifications_enabled", true)
  const staffWithEmail = (staff ?? []).filter(
    (p): p is { id: string; email: string } => !!p.email
  )
  // Honor each staffer's client_decisions/email preference.
  const gated = await Promise.all(
    staffWithEmail.map(async (p) =>
      (await isChannelEnabled(
        admin,
        { profileId: p.id },
        "client_decisions",
        "email"
      ))
        ? p.email
        : null
    )
  )
  const emails = gated.filter((e): e is string => !!e)
  if (!emails.length) {
    console.warn(
      "[approved-decision email] skipped — no staff with notifications_enabled + an email on file"
    )
    return
  }
  console.log(
    `[approved-decision email] sending decision ${decisionId} to ${emails.length} staff`
  )

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

  // Build + send inside a try so a formatting edge case in the rich HTML can
  // never silently swallow the whole notification — on failure we fall back to
  // a plain-text email so staff are still told. The send result is logged
  // either way for observability.
  try {
  const d = decision as unknown as {
    number: number
    kind: "selection" | "change_order"
    title: string
    description: string | null
    cost_delta: number | null
    markup_percent: number | null
    delay_days: number | null
    delay_cost_per_day: number | null
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
    : "Team"
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
  // Schedule impact — quoted on every change order (null only on pre-feature
  // rows). The delay cost is already inside cost_delta; say so.
  const delayText =
    d.kind === "change_order" && d.delay_days != null
      ? d.delay_days > 0
        ? `${d.delay_days} day${d.delay_days === 1 ? "" : "s"} × ${formatCurrency(
            Number(d.delay_cost_per_day) || 0
          )}/day = ${formatCurrency(
            d.delay_days * (Number(d.delay_cost_per_day) || 0)
          )} (included in cost impact)`
        : "none"
      : null
  if (delayText) textLines.push(`Schedule delay: ${delayText}`)
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
        ? `[${ci.cost_codes.name}] `
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
    delayText ? row("Schedule delay", escapeHtml(delayText)) : "",
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
                  ci.cost_codes.name
                )}]</span> `
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

  const res = await sendEmail({
    to: emails,
    subject: `${kindLabel} #${d.number} approved — ${d.title}`,
    text,
    html,
  })
  if (res.sent) {
    console.log(
      `[approved-decision email] sent to ${emails.length} staff for decision ${decisionId}`
    )
  } else {
    console.warn(
      `[approved-decision email] Resend did not send: ${res.reason}`
    )
  }
  } catch (e) {
    // Last-resort fallback: the rich build threw (helpers are null-safe, so
    // this should be unreachable, but we never want an approval to produce no
    // email). Send a minimal plain-text notice instead.
    console.warn(
      "[approved-decision email] rich email failed; sending plain fallback:",
      e instanceof Error ? e.message : e
    )
    const dd = decision as {
      number?: number
      title?: string | null
      project_id?: string
    }
    const fb = await sendEmail({
      to: emails,
      subject: `Decision${dd.number ? ` #${dd.number}` : ""} approved${
        dd.title ? ` — ${dd.title}` : ""
      }`,
      text: `A decision was approved on the project portal. Open it in the app: ${appUrl(
        `/projects/${dd.project_id ?? ""}/decisions`
      )}`,
    })
    if (!fb.sent) {
      console.warn(
        `[approved-decision email] fallback send also failed: ${fb.reason}`
      )
    }
  }
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

  // Idempotency lives in `decision_followup_materializations` (junction
  // table, migration 0023). Its primary key is (decision_id, template_id),
  // so re-approving a decision can't double-create a followup even if the
  // schedule_item's description was edited later. Prior behaviour
  // (description-LIKE match on a marker) was brittle.
  const { data: existing } = await supabase
    .from("decision_followup_materializations")
    .select("template_id")
    .eq("decision_id", decisionId)
  const materializedTemplateIds = new Set(
    (existing ?? []).map((r) => r.template_id)
  )

  const approvedDate = todayISO()
  const newTemplates = templates.filter((t) => !materializedTemplateIds.has(t.id))
  if (newTemplates.length === 0) return 0

  // Pre-load the start/end dates of every schedule item an anchored template
  // points at, so we can compute each follow-up's date without a per-template
  // round trip. Anchored to-dos also copy parent_id/anchor/offset onto the new
  // schedule_item so the existing schedule cascade keeps them in sync.
  const anchorIds = Array.from(
    new Set(
      newTemplates
        .map((t) => t.anchor_schedule_item_id)
        .filter((x): x is string => !!x)
    )
  )
  const anchorDates = new Map<
    string,
    { start_date: string | null; end_date: string | null }
  >()
  if (anchorIds.length) {
    const { data: anchors } = await supabase
      .from("schedule_items")
      .select("id, start_date, end_date")
      .in("id", anchorIds)
    for (const a of anchors ?? []) {
      anchorDates.set(a.id, {
        start_date: a.start_date,
        end_date: a.end_date,
      })
    }
  }

  // Translate a template's scheduling recipe (kind, fixed offset, or anchor)
  // into the concrete schedule_items columns. Mirrors the SQL in the
  // client_decide_decision RPC (migration 0035) — keep the two in step.
  function followupScheduleFields(t: (typeof newTemplates)[number]) {
    const anchored =
      !!t.anchor_schedule_item_id &&
      !!t.parent_anchor &&
      t.parent_offset_days != null
    const basis = anchored
      ? (() => {
          const a = anchorDates.get(t.anchor_schedule_item_id!)
          if (!a) return null
          return t.parent_anchor === "start" ? a.start_date : a.end_date
        })()
      : null

    if (t.kind === "work") {
      const start = anchored
        ? basis
          ? addDays(basis, t.parent_offset_days!)
          : null
        : addDays(approvedDate, t.due_offset_days)
      const dur = t.duration_days ?? 1
      const end = start ? addDays(start, dur - 1) : null
      return {
        parent_id: null as string | null,
        start_date: start,
        end_date: end,
        due_date: null as string | null,
        duration_days: start && end ? dur : null,
        parent_anchor: null as "start" | "end" | null,
        parent_offset_days: null as number | null,
      }
    }

    // to-do
    if (anchored) {
      return {
        parent_id: t.anchor_schedule_item_id!,
        start_date: null as string | null,
        end_date: null as string | null,
        due_date: basis ? addDays(basis, t.parent_offset_days!) : null,
        duration_days: null as number | null,
        parent_anchor: t.parent_anchor as "start" | "end",
        parent_offset_days: t.parent_offset_days!,
      }
    }
    return {
      parent_id: null as string | null,
      start_date: null as string | null,
      end_date: null as string | null,
      due_date: addDays(approvedDate, t.due_offset_days),
      duration_days: null as number | null,
      parent_anchor: null as "start" | "end" | null,
      parent_offset_days: null as number | null,
    }
  }

  // Claim-then-insert pattern (CodeRabbit #29). The earlier flow inserted
  // the schedule_item first and only recorded the materialization row at
  // the end — two concurrent approvals could both insert a schedule_item
  // for the same template before either junction insert ran, producing
  // duplicates. Insert the junction row FIRST with schedule_item_id =
  // NULL; the PK on (decision_id, template_id) makes this atomic. Only
  // the winning insert proceeds to create the schedule_item; the loser
  // gets a 23505 and silently skips. After the schedule_item lands, we
  // link it back into the junction row. Every error is fatal — partial
  // work would otherwise hide ghost rows on either side.
  const idByTemplateId = new Map<string, string>()
  for (const t of newTemplates) {
    const { error: claimErr } = await supabase
      .from("decision_followup_materializations")
      .insert({
        decision_id: decisionId,
        template_id: t.id,
        schedule_item_id: null,
      })
    if (claimErr) {
      // 23505 = unique violation = another in-flight approval claimed
      // this template. Skip the materialization here; the winning
      // process owns the schedule_item insert.
      if ((claimErr as { code?: string }).code === "23505") continue
      throw new Error(claimErr.message)
    }

    const sched = followupScheduleFields(t)
    const { data: si, error: siErr } = await supabase
      .from("schedule_items")
      .insert({
        project_id: projectId,
        parent_id: sched.parent_id,
        kind: t.kind,
        title: t.title,
        description: t.notes,
        start_date: sched.start_date,
        end_date: sched.end_date,
        due_date: sched.due_date,
        duration_days: sched.duration_days,
        parent_anchor: sched.parent_anchor,
        parent_offset_days: sched.parent_offset_days,
        source_decision_id: decisionId,
        created_by: createdBy,
      })
      .select("id")
      .single()
    if (siErr) {
      // Roll back our junction claim so a retry can re-attempt cleanly.
      await supabase
        .from("decision_followup_materializations")
        .delete()
        .eq("decision_id", decisionId)
        .eq("template_id", t.id)
      throw new Error(siErr.message)
    }

    const { error: linkErr } = await supabase
      .from("decision_followup_materializations")
      .update({ schedule_item_id: si.id })
      .eq("decision_id", decisionId)
      .eq("template_id", t.id)
    if (linkErr) {
      // Schedule item exists but isn't linked. Fail loudly — leaving a
      // dangling row would let a re-approval skip the template (it's
      // claimed) without ever surfacing the orphan schedule_item.
      throw new Error(`Failed to link followup junction: ${linkErr.message}`)
    }

    idByTemplateId.set(t.id, si.id)
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

  return newTemplates.length
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
  // Attachment Storage objects are NOT removed here: the delete is captured
  // into deleted_items (0088) so it can be restored from the History tab, and
  // the trash purge removes the objects when the entry expires unrestored.
  const { error } = await supabase.from("decisions").delete().eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/decisions`)
}

/**
 * Reset an approved change order / selection back to `draft` so staff can edit
 * and re-run the workflow. Undoes the approval: clears approval metadata + the
 * client's chosen option, and removes the follow-up schedule items this
 * decision auto-created (plus their materialization rows) so a later
 * re-approval recreates them cleanly. cost_delta is cleared for selections
 * (it's derived from the chosen choice on approval); change orders keep their
 * breakdown-derived cost.
 */
export async function resetDecision({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: cur, error: curErr } = await supabase
    .from("decisions")
    .select("status, kind")
    .eq("id", id)
    .maybeSingle()
  if (curErr) throw new Error(curErr.message)
  if (!cur) throw new Error("Decision not found")
  if (cur.status !== "approved") {
    throw new Error("Only approved decisions can be reset.")
  }

  // Remove the follow-up schedule items this decision created so re-approval
  // doesn't leave duplicates. The junction rows go too (FK would null the
  // schedule_item_id on delete, but we want the template free to re-materialize).
  const { data: mats } = await supabase
    .from("decision_followup_materializations")
    .select("schedule_item_id")
    .eq("decision_id", id)
  const scheduleItemIds = (mats ?? [])
    .map((m) => m.schedule_item_id)
    .filter((x): x is string => !!x)
  if (scheduleItemIds.length) {
    const { error: delSiErr } = await supabase
      .from("schedule_items")
      .delete()
      .in("id", scheduleItemIds)
    if (delSiErr) throw new Error(delSiErr.message)
  }
  const { error: delMatErr } = await supabase
    .from("decision_followup_materializations")
    .delete()
    .eq("decision_id", id)
  if (delMatErr) throw new Error(delMatErr.message)

  const updateRow: TablesUpdate<"decisions"> = {
    status: "draft",
    approved_at: null,
    approved_by_client_id: null,
    selected_choice_id: null,
  }
  if (cur.kind === "selection") updateRow.cost_delta = null

  // Atomic guard: only flip a row that's still approved, so two concurrent
  // resets don't both run the followup cleanup.
  const { error } = await supabase
    .from("decisions")
    .update(updateRow)
    .eq("id", id)
    .eq("status", "approved")
  if (error) throw new Error(error.message)

  revalidatePath(`/projects/${project_id}/decisions`)
  revalidatePath(`/projects/${project_id}/schedule`)
  return { id }
}

/**
 * Duplicate a decision into the same project or another one. The copy lands as
 * a fresh `draft` with a new per-project number and no approval state. Copies
 * the cost breakdown, choices (selections), follow-up templates, and
 * attachments (blob + row). When copying across projects, schedule-item
 * anchors on follow-ups are dropped (they'd reference items in the source
 * project) and fall back to the fixed "days after approval" offset.
 */
export async function copyDecision({
  id,
  target_project_id,
}: {
  id: string
  target_project_id: string
}) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: src, error: srcErr } = await supabase
    .from("decisions")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (srcErr) throw new Error(srcErr.message)
  if (!src) throw new Error("Decision not found")

  // Confirm the target project is one the caller can write to (RLS would block
  // the insert anyway, but this gives a clearer error).
  const { data: targetProject, error: tgtErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", target_project_id)
    .maybeSingle()
  if (tgtErr) throw new Error(tgtErr.message)
  if (!targetProject) throw new Error("Target project not found.")

  const sameProject = src.project_id === target_project_id

  // Allocate a number in the target project, retrying on the unique race the
  // same way saveDecision does.
  let newId: string | null = null
  for (let attempt = 0; attempt < 5 && !newId; attempt++) {
    const { data: nextNum, error: rpcErr } = await supabase.rpc(
      "next_decision_number",
      { p_project: target_project_id }
    )
    if (rpcErr) throw new Error(rpcErr.message)
    const number = Number(nextNum)
    const { data, error } = await supabase
      .from("decisions")
      .insert({
        project_id: target_project_id,
        kind: src.kind,
        title: src.title,
        description: src.description,
        cost_delta: src.kind === "selection" ? null : src.cost_delta,
        markup_percent: src.markup_percent,
        delay_days: src.delay_days,
        delay_cost_per_day: src.delay_cost_per_day,
        allowance_amount: src.allowance_amount,
        allowance_cost_code_id: src.allowance_cost_code_id,
        status: "draft",
        due_date: src.due_date,
        // The due-date link only survives a same-project copy — across
        // projects it would point at the source project's schedule. The
        // copied fixed due_date stays either way.
        due_anchor_schedule_item_id: sameProject
          ? src.due_anchor_schedule_item_id
          : null,
        due_anchor: sameProject ? src.due_anchor : null,
        due_anchor_offset_days: sameProject ? src.due_anchor_offset_days : null,
        template_tags: src.template_tags,
        number,
        created_by: profile.id,
      })
      .select("id")
      .single()
    if (!error) {
      newId = data.id
      break
    }
    if (error.code !== "23505") throw new Error(error.message)
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
  }
  if (!newId) {
    throw new Error("Could not allocate a decision number after 5 attempts.")
  }

  // Choices first — we need the old→new id map to remap per-choice cost items
  // and attachments.
  const choiceIdMap = new Map<string, string>()
  const { data: srcChoices } = await supabase
    .from("decision_choices")
    .select("*")
    .eq("decision_id", id)
    .order("position", { ascending: true })
  for (const c of srcChoices ?? []) {
    const { data: ins, error: cErr } = await supabase
      .from("decision_choices")
      .insert({
        decision_id: newId,
        title: c.title,
        description: c.description,
        price_delta: c.price_delta,
        position: c.position,
      })
      .select("id")
      .single()
    if (cErr) throw new Error(cErr.message)
    choiceIdMap.set(c.id, ins.id)
  }

  // Cost items (decision-level + per-choice).
  const { data: srcCostItems } = await supabase
    .from("decision_cost_items")
    .select("*")
    .eq("decision_id", id)
    .order("position", { ascending: true })
  if (srcCostItems?.length) {
    const rows = srcCostItems.map((ci) => ({
      decision_id: newId!,
      choice_id: ci.choice_id ? choiceIdMap.get(ci.choice_id) ?? null : null,
      cost_code_id: ci.cost_code_id,
      description: ci.description,
      quantity: ci.quantity,
      unit: ci.unit,
      unit_cost: ci.unit_cost,
      catalog_item_id: ci.catalog_item_id,
      catalog_item_code: ci.catalog_item_code,
      position: ci.position,
    }))
    const { error: ciErr } = await supabase
      .from("decision_cost_items")
      .insert(rows)
    if (ciErr) throw new Error(ciErr.message)
  }

  // Follow-up templates. Drop schedule-item anchors when copying to another
  // project — the anchor would point at the source project's schedule.
  const { data: srcFollowups } = await supabase
    .from("decision_followup_templates")
    .select("*")
    .eq("decision_id", id)
    .order("position", { ascending: true })
  if (srcFollowups?.length) {
    const rows = srcFollowups.map((f) => {
      const keepAnchor = sameProject && !!f.anchor_schedule_item_id
      return {
        decision_id: newId!,
        title: f.title,
        kind: f.kind,
        assignee_profile_id: f.assignee_profile_id,
        assignee_company_id: f.assignee_company_id,
        due_offset_days: f.due_offset_days,
        duration_days: f.duration_days,
        anchor_schedule_item_id: keepAnchor ? f.anchor_schedule_item_id : null,
        parent_anchor: keepAnchor ? f.parent_anchor : null,
        parent_offset_days: keepAnchor ? f.parent_offset_days : null,
        notes: f.notes,
        position: f.position,
      }
    })
    const { error: fErr } = await supabase
      .from("decision_followup_templates")
      .insert(rows)
    if (fErr) throw new Error(fErr.message)
  }

  // Assignments — people and roles are project-agnostic (roles re-resolve
  // through the target project's role map), so they copy verbatim.
  const { data: srcAssignments } = await supabase
    .from("decision_assignments")
    .select("profile_id, company_id, role_id")
    .eq("decision_id", id)
  if (srcAssignments?.length) {
    const { error: dassErr } = await supabase
      .from("decision_assignments")
      .insert(
        srcAssignments.map((a) => ({
          decision_id: newId!,
          profile_id: a.profile_id,
          company_id: a.company_id,
          role_id: a.role_id,
        }))
      )
    if (dassErr) {
      console.warn("[copyDecision] assignment copy failed:", dassErr.message)
    }
  }

  // Attachments — copy the storage blob into a fresh key under the target
  // project, then record the row. A failed blob copy is non-fatal (skip that
  // attachment) so one missing file doesn't abort the whole duplicate.
  const { data: srcAtts } = await supabase
    .from("decision_attachments")
    .select("*")
    .eq("decision_id", id)
    .order("position", { ascending: true })
  for (const a of srcAtts ?? []) {
    const ext = a.file_name.split(".").pop()?.toLowerCase() ?? "bin"
    const newPath = `projects/${target_project_id}/decisions/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`
    const { error: copyErr } = await supabase.storage
      .from("project-files")
      .copy(a.storage_path, newPath)
    if (copyErr) {
      console.warn(
        "[copyDecision] attachment blob copy failed (skipping):",
        copyErr.message
      )
      continue
    }
    const { error: aErr } = await supabase.from("decision_attachments").insert({
      decision_id: newId,
      choice_id: a.choice_id ? choiceIdMap.get(a.choice_id) ?? null : null,
      storage_bucket: a.storage_bucket,
      storage_path: newPath,
      file_name: a.file_name,
      file_type: a.file_type,
      file_size: a.file_size,
      caption: a.caption,
      position: a.position,
    })
    if (aErr) {
      // Row insert failed after the blob copied — clean up the orphan blob.
      await supabase.storage.from("project-files").remove([newPath])
      throw new Error(aErr.message)
    }
  }

  revalidatePath(`/projects/${target_project_id}/decisions`)
  if (!sameProject) revalidatePath(`/projects/${src.project_id}/decisions`)
  return { id: newId, project_id: target_project_id, sameProject }
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

  // Best-effort bell fan-out — decision comments used to be silent, so a
  // client note could sit unseen until someone happened to open the drawer.
  try {
    const { data: d } = await supabase
      .from("decisions")
      .select("number, title, projects:project_id(name)")
      .eq("id", decision_id)
      .maybeSingle()
    const dec = d as unknown as {
      number: number
      title: string
      projects: { name: string } | null
    } | null
    let counterpartyIds: string[] = []
    if (profile.role === "staff") {
      const { data: members } = await supabase
        .from("project_members")
        .select("profile_id, profiles!inner(role)")
        .eq("project_id", project_id)
      counterpartyIds = (members ?? [])
        .filter(
          (m) => (m as unknown as { profiles: { role: string } }).profiles.role === "client"
        )
        .map((m) => m.profile_id)
    }
    const link = `/projects/${project_id}/decisions?open=${decision_id}`
    await notifyCommentPosted({
      entityLabel: dec ? `Decision #${dec.number} — ${dec.title}` : "a decision",
      projectName: dec?.projects?.name ?? null,
      authorName: profile.full_name ?? profile.email ?? "Someone",
      authorIsStaff: profile.role === "staff",
      authorProfileId: profile.id,
      body: body.trim(),
      staffLink: link,
      counterpartyProfileIds: counterpartyIds,
      counterpartyLink: link,
    })
  } catch (e) {
    console.warn("decision comment notification failed:", e)
  }

  revalidatePath(`/projects/${project_id}/decisions`)
  revalidatePath(`/projects/${project_id}/communications`)
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
      // Client path (no org membership) — resolve the org from the decision's
      // project so the dashboard webhook still gates on the legacy org.
      const { data: proj } = await supabase
        .from("projects")
        .select("org_id")
        .eq("id", decisionRow.project_id)
        .maybeSingle()
      await sendDashboardWebhook(
        "decision.approved",
        decisionRow,
        proj?.org_id ?? null
      )
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
  await requireSession()
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

// ============================================================================
// Client "request due-date reset", bulk copy, and the disclaimer setting
// ============================================================================

export type RequestDueDateResetResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * A client whose change order / selection is past its due date can no longer
 * approve it (gate in the client_decide_decision RPC, migration 0074). This
 * action is their escape hatch: it leaves a comment on the decision (the
 * durable, client-visible record of the request) and notifies staff in-app +
 * by email so someone extends the due date.
 *
 * requireSession, not requireStaff — clients call this. The RLS-scoped read
 * doubles as the authorization check (clients only see non-draft decisions on
 * their own projects).
 */
export async function requestDueDateReset(input: {
  decision_id: string
  project_id: string
}): Promise<RequestDueDateResetResult> {
  const profile = await requireSession()
  const parsed = z
    .object({ decision_id: z.string().uuid(), project_id: z.string().uuid() })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: "Bad input." }
  const { decision_id, project_id } = parsed.data
  const supabase = await createSupabaseServerClient()

  const { data: decision, error: dErr } = await supabase
    .from("decisions")
    .select("id, number, kind, title, status, due_date, project_id")
    .eq("id", decision_id)
    .eq("project_id", project_id)
    .maybeSingle()
  if (dErr) return { ok: false, error: dErr.message }
  if (!decision) return { ok: false, error: "Decision not found." }
  if (decision.status !== "pending_client") {
    return { ok: false, error: "This item isn't awaiting approval." }
  }
  // Mirror the RPC's gate: the reset request only exists because approval is
  // blocked. A not-actually-overdue decision doesn't need one (and shouldn't
  // let anyone poke staff-wide email).
  const today = new Date().toISOString().slice(0, 10)
  if (!decision.due_date || decision.due_date >= today) {
    return { ok: false, error: "This item isn't past its due date." }
  }

  // Throttle: one request per person per decision per day. Repeat clicks are
  // an idempotent success rather than another staff-wide email.
  const { data: recent } = await supabase
    .from("decision_comments")
    .select("id")
    .eq("decision_id", decision_id)
    .eq("author_id", profile.id)
    .ilike("body", "Requested a due-date reset%")
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .limit(1)
  if (recent && recent.length > 0) {
    return { ok: true }
  }

  // The comment is the audit trail; RLS enforces author_id = auth.uid().
  const { error: cErr } = await supabase.from("decision_comments").insert({
    decision_id,
    author_id: profile.id,
    body: "Requested a due-date reset — the approval window has passed and I'd still like to respond.",
  })
  if (cErr) return { ok: false, error: cErr.message }

  // Staff fan-out via the admin client (clients can't insert notifications).
  const admin = createSupabaseAdminClient()
  if (admin) {
    const kindLabel =
      decision.kind === "selection" ? "Selection" : "Change order"
    const title = `${kindLabel} #${decision.number}: due-date reset requested`
    const link = `/projects/${project_id}/decisions?open=${decision_id}`
    const { data: staff } = await admin
      .from("profiles")
      .select("id, email, notifications_enabled")
      .eq("role", "staff")
    const recipients = (staff ?? []).filter((s) => s.notifications_enabled)
    if (recipients.length) {
      const { error: nErr } = await admin.from("notifications").insert(
        recipients.map((s) => ({
          recipient_id: s.id,
          type: "decision_due_reset_request",
          title,
          body: `${profile.full_name ?? "A client"} asked to extend the due date on "${decision.title}".`,
          link_url: link,
        }))
      )
      if (nErr) {
        console.warn("[requestDueDateReset] notifications failed:", nErr.message)
      }
      const emails = recipients
        .map((s) => s.email)
        .filter((e): e is string => !!e)
      if (emails.length) {
        await sendEmail({
          to: emails,
          subject: title,
          text: `${profile.full_name ?? "A client"} asked to extend the due date on "${decision.title}" so they can respond. Open: ${appUrl(link)}`,
          log: {
            project_id,
            profile_id: null,
            sent_by: profile.id,
            kind: "decision_due_reset_request",
            counterparty_name: null,
          },
        }).catch((e) =>
          console.warn("[requestDueDateReset] email failed:", e)
        )
      }
    }
  }

  revalidatePath(`/projects/${project_id}/decisions`)
  return { ok: true }
}

export type BulkCopyDecisionsResult = {
  ok: number
  skipped: { id: string; reason: string }[]
}

/**
 * Copies each selected decision into the target project — the multi-select
 * counterpart of copyDecision (which does all the heavy lifting per id:
 * number allocation, choices/cost items/followups/assignments/attachments,
 * cross-project anchor dropping).
 */
export async function bulkCopyDecisions(input: {
  project_id: string
  ids: string[]
  target_project_id: string
}): Promise<BulkCopyDecisionsResult> {
  await requireStaff()
  const parsed = z
    .object({
      project_id: z.string().uuid(),
      ids: z.array(z.string().uuid()).min(1).max(100),
      target_project_id: z.string().uuid(),
    })
    .parse(input)

  const supabase = await createSupabaseServerClient()
  // Scope the ids to the source project so a forged id can't copy another
  // project's decision even with a valid staff session.
  const { data: rows, error } = await supabase
    .from("decisions")
    .select("id")
    .in("id", parsed.ids)
    .eq("project_id", parsed.project_id)
  if (error) throw new Error(error.message)
  const validIds = new Set((rows ?? []).map((r) => r.id))

  const skipped: { id: string; reason: string }[] = []
  let ok = 0
  for (const id of parsed.ids) {
    if (!validIds.has(id)) {
      skipped.push({ id, reason: "not found in project (or RLS denied)" })
      continue
    }
    try {
      await copyDecision({ id, target_project_id: parsed.target_project_id })
      ok++
    } catch (e) {
      skipped.push({
        id,
        reason: e instanceof Error ? e.message : "copy failed",
      })
    }
  }
  return { ok, skipped }
}

// NOT exported: "use server" modules may only export async functions. The
// decisions page hardcodes the same key when reading app_settings.
const DECISION_DISCLAIMER_KEY = "decision_disclaimer"

export type SaveDisclaimerResult = { ok: true } | { ok: false; error: string }

/**
 * Org-wide default disclaimer shown to clients at the bottom of every change
 * order and selection (app_settings key 'decision_disclaimer', migration
 * 0077). Empty text clears it.
 */
export async function saveDecisionDisclaimer(input: {
  text: string
}): Promise<SaveDisclaimerResult> {
  const profile = await requireStaff()
  const parsed = z.object({ text: z.string().max(4000) }).safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Disclaimer is too long (4000 chars max)." }
  }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("app_settings").upsert(
    {
      org_id: await getActiveOrgId(supabase),
      key: DECISION_DISCLAIMER_KEY,
      value: parsed.data.text.trim() || null,
      updated_by: profile.id,
    },
    { onConflict: "org_id,key" }
  )
  if (error) return { ok: false, error: error.message }
  // Every project's decisions tab renders the disclaimer — invalidate them
  // all so the new text shows without waiting out the router cache.
  revalidatePath("/projects/[id]/decisions", "page")
  return { ok: true }
}
