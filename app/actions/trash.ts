"use server"

// Restore for "Recently deleted" (migration 0088). The capture trigger
// snapshots each directly-deleted schedule item / decision / daily log /
// file / bid package / PO (plus all child rows) into deleted_items; this
// action rebuilds the rows with their original ids.
//
// Restore is claim-then-insert: claim_deleted_item atomically stamps
// restored_at, so a double-click or concurrent restore lands on "already
// restored" instead of duplicating rows. The main row insert is fatal (claim
// released on failure); child rows are best-effort — a reference that no
// longer resolves (deleted company, profile, cost code, schedule item…) is
// nulled or skipped with a warning rather than blocking the whole restore.
// All inserts run under the caller's session, so RLS stays the gate.

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { wouldCreateCycle } from "@/lib/schedule/scheduling"
import type { SnapshotRow, TrashPayload } from "@/lib/trash"
import type { TablesInsert } from "@/lib/db/types"

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>

const PATH_FOR_TYPE: Record<string, string> = {
  work_item: "schedule",
  todo: "schedule",
  change_order: "decisions",
  selection: "decisions",
  daily_log: "daily-logs",
  file: "files",
  bid_package: "bids",
  purchase_order: "purchase-orders",
}

const TABLE_FOR_TYPE = {
  work_item: "schedule_items",
  todo: "schedule_items",
  change_order: "decisions",
  selection: "decisions",
  daily_log: "daily_logs",
  file: "project_files",
  bid_package: "bid_packages",
  purchase_order: "purchase_orders",
} as const

function str(row: SnapshotRow, key: string): string | null {
  const v = row[key]
  return typeof v === "string" ? v : null
}

function rowsOf(payload: TrashPayload, table: string): SnapshotRow[] {
  const rows = payload.children?.[table]
  return Array.isArray(rows) ? rows : []
}

/** Which of `ids` still exist in `table`. */
async function existingIds(
  supabase: Supabase,
  table:
    | "profiles"
    | "companies"
    | "roles"
    | "cost_codes"
    | "schedule_items"
    | "decisions"
    | "bid_recipients",
  ids: (string | null | undefined)[]
): Promise<Set<string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (uniq.length === 0) return new Set()
  const { data, error } = await supabase.from(table).select("id").in("id", uniq)
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map((r) => r.id))
}

/** Null `key` on `row` when it points at a row that no longer exists. */
function dropMissingRef(row: SnapshotRow, key: string, ok: Set<string>) {
  const v = str(row, key)
  if (v && !ok.has(v)) row[key] = null
}

/**
 * created_by is NOT NULL on schedule_items / decisions / daily_logs — when
 * the original creator's profile is gone, credit the restorer instead.
 */
function fixCreator(row: SnapshotRow, ok: Set<string>, actorId: string) {
  const v = str(row, "created_by")
  if (v && !ok.has(v)) row.created_by = actorId
}

/**
 * Bulk insert, falling back to row-by-row on failure so one bad row (already
 * exists, reference gone) skips with a warning instead of losing the batch.
 * Returns the rows that made it in.
 */
async function insertTolerant(
  label: string,
  rows: SnapshotRow[],
  run: (batch: SnapshotRow[]) => PromiseLike<{
    error: { message: string; code?: string } | null
  }>,
  warnings: string[]
): Promise<SnapshotRow[]> {
  if (rows.length === 0) return []
  const bulk = await run(rows)
  if (!bulk.error) return rows
  const ok: SnapshotRow[] = []
  for (const row of rows) {
    const single = await run([row])
    if (!single.error) {
      ok.push(row)
    } else if (single.error.code === "23505") {
      warnings.push(`${label}: one entry already exists — kept the existing one.`)
    } else {
      warnings.push(`${label}: skipped one entry (${single.error.message}).`)
    }
  }
  return ok
}

/**
 * Per-project numbers can be reused after a delete (the allocators take
 * max+1). On a clash, reallocate through the same advisory-lock RPC the
 * create paths use.
 */
async function ensureFreeNumber(
  supabase: Supabase,
  table: "decisions" | "bid_packages" | "purchase_orders",
  rpc: "next_decision_number" | "next_bid_package_number" | "next_po_number",
  row: SnapshotRow,
  projectId: string,
  label: string,
  warnings: string[]
) {
  const number = row.number
  if (typeof number !== "number") return
  const { data: clash, error } = await supabase
    .from(table)
    .select("id")
    .eq("project_id", projectId)
    .eq("number", number)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!clash) return
  const { data: next, error: rpcErr } = await supabase.rpc(rpc, {
    p_project: projectId,
  })
  if (rpcErr) throw new Error(rpcErr.message)
  row.number = next
  warnings.push(
    `${label} came back as #${next} — its old number #${number} has been reused since it was deleted.`
  )
}

// ---------------------------------------------------------------------------
// Per-entity restores. Each returns the ids of restored top-level entities so
// overlapping trash entries (a to-do that rode along in its parent work
// item's snapshot AND has its own entry from a bulk delete) get claimed too.
// ---------------------------------------------------------------------------

async function restoreScheduleItemTree(
  supabase: Supabase,
  projectId: string,
  entityId: string,
  payload: TrashPayload,
  actorId: string,
  warnings: string[]
): Promise<string[]> {
  const root = { ...payload.row }
  const descendants = rowsOf(payload, "schedule_items").map((r) => ({ ...r }))
  const items = [root, ...descendants]
  const inSnapshot = new Map(items.map((r) => [str(r, "id") ?? "", r]))

  // Parents-first insert order (nested to-dos reference the row above them).
  const depthOf = (row: SnapshotRow): number => {
    let depth = 0
    let cur: SnapshotRow | undefined = row
    while (cur) {
      const parent = str(cur, "parent_id")
      if (!parent || !inSnapshot.has(parent) || depth > 10) break
      depth += 1
      cur = inSnapshot.get(parent)
    }
    return depth
  }
  items.sort((a, b) => depthOf(a) - depthOf(b))

  const assignments = rowsOf(payload, "schedule_assignments").map((r) => ({ ...r }))
  const checklist = rowsOf(payload, "todo_checklist_items").map((r) => ({ ...r }))
  const attachments = rowsOf(payload, "schedule_item_attachments").map((r) => ({ ...r }))
  const comments = rowsOf(payload, "schedule_item_comments").map((r) => ({ ...r }))
  const delays = rowsOf(payload, "schedule_delays").map((r) => ({ ...r }))
  const predecessors = rowsOf(payload, "schedule_predecessors").map((r) => ({ ...r }))

  const okProfiles = await existingIds(supabase, "profiles", [
    ...items.map((r) => str(r, "created_by")),
    ...assignments.map((r) => str(r, "profile_id")),
    ...checklist.map((r) => str(r, "assignee_profile_id")),
    ...attachments.map((r) => str(r, "uploaded_by")),
    ...comments.map((r) => str(r, "author_id")),
    ...delays.map((r) => str(r, "logged_by")),
  ])
  const okCompanies = await existingIds(supabase, "companies", [
    ...assignments.map((r) => str(r, "company_id")),
    ...checklist.map((r) => str(r, "assignee_company_id")),
  ])
  const okRoles = await existingIds(supabase, "roles", [
    ...assignments.map((r) => str(r, "role_id")),
    ...checklist.map((r) => str(r, "assignee_role_id")),
  ])
  const okDecisions = await existingIds(
    supabase,
    "decisions",
    items.map((r) => str(r, "source_decision_id"))
  )
  // Schedule items referenced from outside the snapshot (an external parent,
  // a recurrence anchor, the other end of a predecessor edge).
  const okItems = await existingIds(supabase, "schedule_items", [
    ...items.flatMap((r) => [str(r, "parent_id"), str(r, "recurrence_parent_id")]),
    ...predecessors.flatMap((r) => [str(r, "item_id"), str(r, "predecessor_id")]),
  ])

  // Freshly-inserted items (their children need re-inserting) vs items that
  // are present either way (a child restored separately earlier still counts
  // as a valid parent, and its trash entry must be claimed below).
  const restoredIds: string[] = []
  const present = new Set<string>()
  for (const item of items) {
    const id = str(item, "id") ?? ""
    const parentId = str(item, "parent_id")
    if (parentId && !present.has(parentId) && !okItems.has(parentId)) {
      // Parent neither restored ahead of this row nor still on the schedule:
      // it comes back standalone. The anchor pair rides on parent_id
      // (schedule_items_parent_anchor_kind_chk), so clear it too.
      item.parent_id = null
      item.parent_anchor = null
      item.parent_offset_days = null
      warnings.push(
        `"${str(item, "title") ?? "Item"}" was nested under an item that no longer exists — restored as standalone.`
      )
    }
    const recurrenceParent = str(item, "recurrence_parent_id")
    if (
      recurrenceParent &&
      !present.has(recurrenceParent) &&
      !okItems.has(recurrenceParent)
    ) {
      item.recurrence_parent_id = null
    }
    dropMissingRef(item, "source_decision_id", okDecisions)
    fixCreator(item, okProfiles, actorId)

    const { error } = await supabase
      .from("schedule_items")
      .insert(item as unknown as TablesInsert<"schedule_items">)
    if (error) {
      if (id === entityId) throw new Error(`Couldn't restore: ${error.message}`)
      if (error.code === "23505") {
        // Already on the schedule (restored on its own before its parent).
        present.add(id)
        warnings.push(
          `"${str(item, "title") ?? "Item"}" already exists — kept the existing one.`
        )
      } else {
        warnings.push(
          `"${str(item, "title") ?? "Item"}" couldn't be restored (${error.message}).`
        )
      }
      continue
    }
    restoredIds.push(id)
    present.add(id)
  }
  const restored = new Set(restoredIds)

  const forRestored = (rows: SnapshotRow[], key: string) =>
    rows.filter((r) => restored.has(str(r, key) ?? ""))

  const okAssignments = forRestored(assignments, "schedule_item_id").filter((a) => {
    const profile = str(a, "profile_id")
    const company = str(a, "company_id")
    const role = str(a, "role_id")
    if (profile && !okProfiles.has(profile)) return false
    if (company && !okCompanies.has(company)) return false
    if (role && !okRoles.has(role)) return false
    return true
  })
  if (okAssignments.length < forRestored(assignments, "schedule_item_id").length) {
    warnings.push("Some assignments were dropped — the person, company or role is gone.")
  }
  await insertTolerant(
    "Assignments",
    okAssignments,
    (batch) =>
      supabase
        .from("schedule_assignments")
        .insert(batch as unknown as TablesInsert<"schedule_assignments">[]),
    warnings
  )

  for (const row of checklist) {
    dropMissingRef(row, "assignee_profile_id", okProfiles)
    dropMissingRef(row, "assignee_company_id", okCompanies)
    dropMissingRef(row, "assignee_role_id", okRoles)
  }
  await insertTolerant(
    "Checklist items",
    forRestored(checklist, "schedule_item_id"),
    (batch) =>
      supabase
        .from("todo_checklist_items")
        .insert(batch as unknown as TablesInsert<"todo_checklist_items">[]),
    warnings
  )

  for (const row of attachments) dropMissingRef(row, "uploaded_by", okProfiles)
  await insertTolerant(
    "Attachments",
    forRestored(attachments, "schedule_item_id"),
    (batch) =>
      supabase
        .from("schedule_item_attachments")
        .insert(batch as unknown as TablesInsert<"schedule_item_attachments">[]),
    warnings
  )

  for (const row of comments) dropMissingRef(row, "author_id", okProfiles)
  await insertTolerant(
    "Comments",
    forRestored(comments, "schedule_item_id"),
    (batch) =>
      supabase
        .from("schedule_item_comments")
        .insert(batch as unknown as TablesInsert<"schedule_item_comments">[]),
    warnings
  )

  for (const row of delays) dropMissingRef(row, "logged_by", okProfiles)
  await insertTolerant(
    "Delay log",
    forRestored(delays, "schedule_item_id"),
    (batch) =>
      supabase
        .from("schedule_delays")
        .insert(batch as unknown as TablesInsert<"schedule_delays">[]),
    warnings
  )

  // Predecessor edges: both ends must exist, and re-adding must not create a
  // cycle against edges added since the delete (the delete flow lets users
  // re-wire successors around the doomed item).
  const { data: currentEdges, error: edgeErr } = await supabase
    .from("schedule_predecessors")
    .select("id, item_id, predecessor_id, dep_type, lag_days, created_at")
  if (edgeErr) {
    warnings.push(`Dependencies not restored (${edgeErr.message}).`)
  } else {
    const accepted = [...(currentEdges ?? [])]
    for (const edge of predecessors) {
      const itemId = str(edge, "item_id") ?? ""
      const predId = str(edge, "predecessor_id") ?? ""
      const bothExist =
        (present.has(itemId) || okItems.has(itemId)) &&
        (present.has(predId) || okItems.has(predId))
      if (!bothExist) continue
      if (accepted.some((e) => e.item_id === itemId && e.predecessor_id === predId)) {
        continue
      }
      if (wouldCreateCycle(accepted, itemId, predId)) {
        warnings.push(
          "One dependency link was dropped — re-adding it would have created a cycle."
        )
        continue
      }
      const { error } = await supabase
        .from("schedule_predecessors")
        .insert(edge as unknown as TablesInsert<"schedule_predecessors">)
      if (error) {
        warnings.push(`One dependency link couldn't be restored (${error.message}).`)
      } else {
        accepted.push({
          id: str(edge, "id") ?? "",
          item_id: itemId,
          predecessor_id: predId,
          dep_type: (str(edge, "dep_type") ?? "FS") as never,
          lag_days: typeof edge.lag_days === "number" ? edge.lag_days : 0,
          created_at: str(edge, "created_at") ?? "",
        })
      }
    }
  }

  // Best-effort re-links: decisions / follow-up templates whose due dates
  // were anchored to these items (the delete froze their dates), and
  // materialization junction rows that pointed here. Each update is a no-op
  // when the target is gone or has been re-anchored since.
  for (const link of payload.links?.anchored_decisions ?? []) {
    if (!present.has(link.schedule_item_id)) continue
    await supabase
      .from("decisions")
      .update({
        due_anchor_schedule_item_id: link.schedule_item_id,
        due_anchor: link.due_anchor,
        due_anchor_offset_days: link.due_anchor_offset_days,
      })
      .eq("id", link.id)
      .is("due_anchor_schedule_item_id", null)
  }
  for (const link of payload.links?.anchored_followup_templates ?? []) {
    if (!present.has(link.schedule_item_id)) continue
    await supabase
      .from("decision_followup_templates")
      .update({
        anchor_schedule_item_id: link.schedule_item_id,
        parent_anchor: link.parent_anchor,
        parent_offset_days: link.parent_offset_days,
      })
      .eq("id", link.id)
      .is("anchor_schedule_item_id", null)
  }
  for (const link of payload.links?.materializations ?? []) {
    if (!present.has(link.schedule_item_id)) continue
    await supabase
      .from("decision_followup_materializations")
      .update({ schedule_item_id: link.schedule_item_id })
      .eq("decision_id", link.decision_id)
      .eq("template_id", link.template_id)
      .is("schedule_item_id", null)
  }

  return [...present]
}

async function restoreDecision(
  supabase: Supabase,
  projectId: string,
  payload: TrashPayload,
  actorId: string,
  warnings: string[]
): Promise<string[]> {
  const row = { ...payload.row }
  const decisionId = str(row, "id") ?? ""
  const choices = rowsOf(payload, "decision_choices").map((r) => ({ ...r }))
  const attachments = rowsOf(payload, "decision_attachments").map((r) => ({ ...r }))
  const costItems = rowsOf(payload, "decision_cost_items").map((r) => ({ ...r }))
  const templates = rowsOf(payload, "decision_followup_templates").map((r) => ({ ...r }))
  const comments = rowsOf(payload, "decision_comments").map((r) => ({ ...r }))
  const assignments = rowsOf(payload, "decision_assignments").map((r) => ({ ...r }))
  const materializations = rowsOf(payload, "decision_followup_materializations").map(
    (r) => ({ ...r })
  )

  const okProfiles = await existingIds(supabase, "profiles", [
    str(row, "created_by"),
    str(row, "approved_by_client_id"),
    ...templates.map((r) => str(r, "assignee_profile_id")),
    ...comments.map((r) => str(r, "author_id")),
    ...assignments.map((r) => str(r, "profile_id")),
  ])
  const okCompanies = await existingIds(supabase, "companies", [
    ...templates.map((r) => str(r, "assignee_company_id")),
    ...assignments.map((r) => str(r, "company_id")),
  ])
  const okRoles = await existingIds(
    supabase,
    "roles",
    assignments.map((r) => str(r, "role_id"))
  )
  const okCostCodes = await existingIds(supabase, "cost_codes", [
    str(row, "allowance_cost_code_id"),
    ...costItems.map((r) => str(r, "cost_code_id")),
  ])
  const okItems = await existingIds(supabase, "schedule_items", [
    str(row, "due_anchor_schedule_item_id"),
    ...templates.map((r) => str(r, "anchor_schedule_item_id")),
    ...materializations.map((r) => str(r, "schedule_item_id")),
  ])

  fixCreator(row, okProfiles, actorId)
  dropMissingRef(row, "approved_by_client_id", okProfiles)
  dropMissingRef(row, "allowance_cost_code_id", okCostCodes)
  const anchorItem = str(row, "due_anchor_schedule_item_id")
  if (anchorItem && !okItems.has(anchorItem)) {
    // All-or-nothing triple (0072); due_date stays canonical, so it just
    // freezes at its last computed value.
    row.due_anchor_schedule_item_id = null
    row.due_anchor = null
    row.due_anchor_offset_days = null
    warnings.push(
      "The schedule item its due date was linked to is gone — the due date is kept but no longer follows the schedule."
    )
  }
  await ensureFreeNumber(
    supabase,
    "decisions",
    "next_decision_number",
    row,
    projectId,
    "The decision",
    warnings
  )

  // selected_choice_id points at a child row that doesn't exist yet — set it
  // after the choices are back.
  const selectedChoice = str(row, "selected_choice_id")
  row.selected_choice_id = null

  const { error: mainErr } = await supabase
    .from("decisions")
    .insert(row as unknown as TablesInsert<"decisions">)
  if (mainErr) throw new Error(`Couldn't restore: ${mainErr.message}`)

  const restoredChoices = await insertTolerant(
    "Choices",
    choices,
    (batch) =>
      supabase
        .from("decision_choices")
        .insert(batch as unknown as TablesInsert<"decision_choices">[]),
    warnings
  )
  const choiceIds = new Set(restoredChoices.map((c) => str(c, "id") ?? ""))

  if (selectedChoice && choiceIds.has(selectedChoice)) {
    await supabase
      .from("decisions")
      .update({ selected_choice_id: selectedChoice })
      .eq("id", decisionId)
  }

  for (const att of attachments) {
    const choice = str(att, "choice_id")
    if (choice && !choiceIds.has(choice)) att.choice_id = null
  }
  await insertTolerant(
    "Attachments",
    attachments,
    (batch) =>
      supabase
        .from("decision_attachments")
        .insert(batch as unknown as TablesInsert<"decision_attachments">[]),
    warnings
  )

  for (const item of costItems) {
    dropMissingRef(item, "cost_code_id", okCostCodes)
    const choice = str(item, "choice_id")
    if (choice && !choiceIds.has(choice)) item.choice_id = null
  }
  await insertTolerant(
    "Cost items",
    costItems,
    (batch) =>
      supabase
        .from("decision_cost_items")
        .insert(batch as unknown as TablesInsert<"decision_cost_items">[]),
    warnings
  )

  for (const t of templates) {
    dropMissingRef(t, "assignee_profile_id", okProfiles)
    dropMissingRef(t, "assignee_company_id", okCompanies)
    const anchor = str(t, "anchor_schedule_item_id")
    if (anchor && !okItems.has(anchor)) {
      t.anchor_schedule_item_id = null
      t.parent_anchor = null
      t.parent_offset_days = null
    }
  }
  const restoredTemplates = await insertTolerant(
    "Follow-up templates",
    templates,
    (batch) =>
      supabase
        .from("decision_followup_templates")
        .insert(batch as unknown as TablesInsert<"decision_followup_templates">[]),
    warnings
  )
  const templateIds = new Set(restoredTemplates.map((t) => str(t, "id") ?? ""))

  for (const c of comments) dropMissingRef(c, "author_id", okProfiles)
  await insertTolerant(
    "Comments",
    comments,
    (batch) =>
      supabase
        .from("decision_comments")
        .insert(batch as unknown as TablesInsert<"decision_comments">[]),
    warnings
  )

  const okAssignments = assignments.filter((a) => {
    const profile = str(a, "profile_id")
    const company = str(a, "company_id")
    const role = str(a, "role_id")
    if (profile && !okProfiles.has(profile)) return false
    if (company && !okCompanies.has(company)) return false
    if (role && !okRoles.has(role)) return false
    return true
  })
  if (okAssignments.length < assignments.length) {
    warnings.push("Some assignments were dropped — the person, company or role is gone.")
  }
  await insertTolerant(
    "Assignments",
    okAssignments,
    (batch) =>
      supabase
        .from("decision_assignments")
        .insert(batch as unknown as TablesInsert<"decision_assignments">[]),
    warnings
  )

  // Restoring the junction keeps a later re-approval idempotent — it must not
  // re-create follow-up items that already exist.
  const okMaterializations = materializations.filter((m) =>
    templateIds.has(str(m, "template_id") ?? "")
  )
  for (const m of okMaterializations) dropMissingRef(m, "schedule_item_id", okItems)
  await insertTolerant(
    "Follow-up records",
    okMaterializations,
    (batch) =>
      supabase
        .from("decision_followup_materializations")
        .insert(
          batch as unknown as TablesInsert<"decision_followup_materializations">[]
        ),
    warnings
  )

  // Follow-up schedule items that survived the delete lost their
  // source_decision_id (SET NULL) — point them back.
  const linkedItems = payload.links?.source_linked_items ?? []
  if (linkedItems.length > 0) {
    await supabase
      .from("schedule_items")
      .update({ source_decision_id: decisionId })
      .in("id", linkedItems)
      .is("source_decision_id", null)
  }

  return [decisionId]
}

async function restoreDailyLog(
  supabase: Supabase,
  payload: TrashPayload,
  actorId: string,
  warnings: string[]
): Promise<string[]> {
  const row = { ...payload.row }
  const logId = str(row, "id") ?? ""
  const subs = rowsOf(payload, "daily_log_subs_on_site").map((r) => ({ ...r }))
  const attachments = rowsOf(payload, "daily_log_attachments").map((r) => ({ ...r }))
  const comments = rowsOf(payload, "daily_log_comments").map((r) => ({ ...r }))

  const okProfiles = await existingIds(supabase, "profiles", [
    str(row, "created_by"),
    ...comments.map((r) => str(r, "author_id")),
  ])
  const okCompanies = await existingIds(
    supabase,
    "companies",
    subs.map((r) => str(r, "company_id"))
  )

  fixCreator(row, okProfiles, actorId)
  const { error: mainErr } = await supabase
    .from("daily_logs")
    .insert(row as unknown as TablesInsert<"daily_logs">)
  if (mainErr) throw new Error(`Couldn't restore: ${mainErr.message}`)

  const okSubs = subs.filter((s) => okCompanies.has(str(s, "company_id") ?? ""))
  if (okSubs.length < subs.length) {
    warnings.push("Some on-site subs were dropped — the company is gone from the directory.")
  }
  await insertTolerant(
    "Subs on site",
    okSubs,
    (batch) =>
      supabase
        .from("daily_log_subs_on_site")
        .insert(batch as unknown as TablesInsert<"daily_log_subs_on_site">[]),
    warnings
  )

  await insertTolerant(
    "Photos",
    attachments,
    (batch) =>
      supabase
        .from("daily_log_attachments")
        .insert(batch as unknown as TablesInsert<"daily_log_attachments">[]),
    warnings
  )

  for (const c of comments) dropMissingRef(c, "author_id", okProfiles)
  await insertTolerant(
    "Comments",
    comments,
    (batch) =>
      supabase
        .from("daily_log_comments")
        .insert(batch as unknown as TablesInsert<"daily_log_comments">[]),
    warnings
  )

  return [logId]
}

async function restoreProjectFile(
  supabase: Supabase,
  payload: TrashPayload,
  warnings: string[]
): Promise<string[]> {
  const row = { ...payload.row }
  const fileId = str(row, "id") ?? ""

  const okProfiles = await existingIds(supabase, "profiles", [str(row, "uploaded_by")])
  dropMissingRef(row, "uploaded_by", okProfiles)

  const parentId = str(row, "parent_file_id")
  if (parentId) {
    const { data: parent } = await supabase
      .from("project_files")
      .select("id")
      .eq("id", parentId)
      .maybeSingle()
    if (!parent) {
      row.parent_file_id = null
      warnings.push("Its earlier revisions are gone — restored as a standalone file.")
    }
  }

  // Version-chain head repair: deleting the head promoted the next-newest
  // revision (deleteProjectFile). Coming back, the restored row is current
  // only when it's still the newest in its chain.
  const chainRoot = str(row, "parent_file_id") ?? fileId
  const { data: headRows } = await supabase
    .from("project_files")
    .select("id, version")
    .eq("is_current", true)
    .or(`id.eq.${chainRoot},parent_file_id.eq.${chainRoot}`)
  const head = headRows?.[0]
  const version = typeof row.version === "number" ? row.version : 1
  let demoteHeadId: string | null = null
  if (!head) {
    row.is_current = true
  } else if (version > (head.version ?? 1)) {
    row.is_current = true
    demoteHeadId = head.id
  } else {
    row.is_current = false
  }

  const { error: mainErr } = await supabase
    .from("project_files")
    .insert(row as unknown as TablesInsert<"project_files">)
  if (mainErr) throw new Error(`Couldn't restore: ${mainErr.message}`)

  if (demoteHeadId) {
    await supabase
      .from("project_files")
      .update({ is_current: false })
      .eq("id", demoteHeadId)
  }

  return [fileId]
}

async function restoreBidPackage(
  supabase: Supabase,
  projectId: string,
  payload: TrashPayload,
  warnings: string[]
): Promise<string[]> {
  const row = { ...payload.row }
  const packageId = str(row, "id") ?? ""
  const lineItems = rowsOf(payload, "bid_package_line_items").map((r) => ({ ...r }))
  const attachments = rowsOf(payload, "bid_package_attachments").map((r) => ({ ...r }))
  const recipients = rowsOf(payload, "bid_recipients").map((r) => ({ ...r }))
  const quotes = rowsOf(payload, "bid_line_item_quotes").map((r) => ({ ...r }))
  const comments = rowsOf(payload, "bid_comments").map((r) => ({ ...r }))

  const okProfiles = await existingIds(supabase, "profiles", [
    str(row, "created_by"),
    ...comments.map((r) => str(r, "author_profile_id")),
  ])
  const okCompanies = await existingIds(
    supabase,
    "companies",
    recipients.map((r) => str(r, "company_id"))
  )
  const okCostCodes = await existingIds(
    supabase,
    "cost_codes",
    lineItems.map((r) => str(r, "cost_code_id"))
  )

  dropMissingRef(row, "created_by", okProfiles)
  await ensureFreeNumber(
    supabase,
    "bid_packages",
    "next_bid_package_number",
    row,
    projectId,
    "The bid package",
    warnings
  )

  const { error: mainErr } = await supabase
    .from("bid_packages")
    .insert(row as unknown as TablesInsert<"bid_packages">)
  if (mainErr) throw new Error(`Couldn't restore: ${mainErr.message}`)

  for (const li of lineItems) dropMissingRef(li, "cost_code_id", okCostCodes)
  const restoredLineItems = await insertTolerant(
    "Line items",
    lineItems,
    (batch) =>
      supabase
        .from("bid_package_line_items")
        .insert(batch as unknown as TablesInsert<"bid_package_line_items">[]),
    warnings
  )
  const lineItemIds = new Set(restoredLineItems.map((r) => str(r, "id") ?? ""))

  await insertTolerant(
    "Attachments",
    attachments,
    (batch) =>
      supabase
        .from("bid_package_attachments")
        .insert(batch as unknown as TablesInsert<"bid_package_attachments">[]),
    warnings
  )

  const okRecipients = recipients.filter((r) =>
    okCompanies.has(str(r, "company_id") ?? "")
  )
  if (okRecipients.length < recipients.length) {
    warnings.push(
      "Some invited subs were dropped — their company is gone from the directory."
    )
  }
  const restoredRecipients = await insertTolerant(
    "Invited subs",
    okRecipients,
    (batch) =>
      supabase
        .from("bid_recipients")
        .insert(batch as unknown as TablesInsert<"bid_recipients">[]),
    warnings
  )
  const recipientIds = new Set(restoredRecipients.map((r) => str(r, "id") ?? ""))

  await insertTolerant(
    "Quotes",
    quotes.filter(
      (q) =>
        recipientIds.has(str(q, "bid_recipient_id") ?? "") &&
        lineItemIds.has(str(q, "line_item_id") ?? "")
    ),
    (batch) =>
      supabase
        .from("bid_line_item_quotes")
        .insert(batch as unknown as TablesInsert<"bid_line_item_quotes">[]),
    warnings
  )

  const okComments = comments.filter((c) =>
    recipientIds.has(str(c, "bid_recipient_id") ?? "")
  )
  for (const c of okComments) dropMissingRef(c, "author_profile_id", okProfiles)
  await insertTolerant(
    "Comments",
    okComments,
    (batch) =>
      supabase
        .from("bid_comments")
        .insert(batch as unknown as TablesInsert<"bid_comments">[]),
    warnings
  )

  return [packageId]
}

async function restorePurchaseOrder(
  supabase: Supabase,
  projectId: string,
  payload: TrashPayload,
  warnings: string[]
): Promise<string[]> {
  const row = { ...payload.row }
  const poId = str(row, "id") ?? ""
  const lineItems = rowsOf(payload, "po_line_items").map((r) => ({ ...r }))
  const attachments = rowsOf(payload, "po_attachments").map((r) => ({ ...r }))
  const comments = rowsOf(payload, "po_comments").map((r) => ({ ...r }))

  const okCompanies = await existingIds(supabase, "companies", [str(row, "company_id")])
  const companyId = str(row, "company_id")
  if (!companyId || !okCompanies.has(companyId)) {
    throw new Error(
      "The subcontractor company on this PO no longer exists in the directory."
    )
  }

  const okProfiles = await existingIds(supabase, "profiles", [
    str(row, "created_by"),
    str(row, "approved_by_profile_id"),
    ...comments.map((r) => str(r, "author_profile_id")),
  ])
  const okRecipients = await existingIds(supabase, "bid_recipients", [
    str(row, "source_bid_recipient_id"),
  ])
  const okCostCodes = await existingIds(
    supabase,
    "cost_codes",
    lineItems.map((r) => str(r, "cost_code_id"))
  )

  dropMissingRef(row, "created_by", okProfiles)
  dropMissingRef(row, "approved_by_profile_id", okProfiles)
  dropMissingRef(row, "source_bid_recipient_id", okRecipients)
  await ensureFreeNumber(
    supabase,
    "purchase_orders",
    "next_po_number",
    row,
    projectId,
    "The PO",
    warnings
  )

  const { error: mainErr } = await supabase
    .from("purchase_orders")
    .insert(row as unknown as TablesInsert<"purchase_orders">)
  if (mainErr) throw new Error(`Couldn't restore: ${mainErr.message}`)

  for (const li of lineItems) dropMissingRef(li, "cost_code_id", okCostCodes)
  await insertTolerant(
    "Line items",
    lineItems,
    (batch) =>
      supabase
        .from("po_line_items")
        .insert(batch as unknown as TablesInsert<"po_line_items">[]),
    warnings
  )

  await insertTolerant(
    "Attachments",
    attachments,
    (batch) =>
      supabase
        .from("po_attachments")
        .insert(batch as unknown as TablesInsert<"po_attachments">[]),
    warnings
  )

  for (const c of comments) dropMissingRef(c, "author_profile_id", okProfiles)
  await insertTolerant(
    "Comments",
    comments,
    (batch) =>
      supabase
        .from("po_comments")
        .insert(batch as unknown as TablesInsert<"po_comments">[]),
    warnings
  )

  return [poId]
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

const RestoreInput = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
})

export type RestoreResult = {
  restored: boolean
  /** True when the entity was already back (restored with its parent). */
  alreadyBack?: boolean
  warnings: string[]
}

export async function restoreDeletedItem(input: {
  id: string
  project_id: string
}): Promise<RestoreResult> {
  const profile = await requireStaff()
  const parsed = RestoreInput.parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: entry, error: entryErr } = await supabase
    .from("deleted_items")
    .select("*")
    .eq("id", parsed.id)
    .eq("project_id", parsed.project_id)
    .maybeSingle()
  if (entryErr) throw new Error(entryErr.message)
  if (!entry) throw new Error("This entry is gone — it may have expired.")
  if (entry.restored_at) {
    return { restored: false, alreadyBack: true, warnings: ["Already restored."] }
  }

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", parsed.project_id)
    .maybeSingle()
  if (projErr) throw new Error(projErr.message)
  if (!project) throw new Error("The project no longer exists.")

  const table = TABLE_FOR_TYPE[entry.entity_type as keyof typeof TABLE_FOR_TYPE]
  if (!table) throw new Error(`Unknown entity type "${entry.entity_type}".`)

  // Already back on the project (restored along with its parent, or the id
  // was somehow recreated)? Mark the entry restored so its expiry never
  // purges Storage objects the live rows reference.
  const { data: existing } = await supabase
    .from(table)
    .select("id")
    .eq("id", entry.entity_id)
    .maybeSingle()
  if (existing) {
    await supabase.rpc("claim_restored_entities", {
      p_project: parsed.project_id,
      p_entity_ids: [entry.entity_id],
    })
    return {
      restored: false,
      alreadyBack: true,
      warnings: [
        "This item is already back on the project — it may have been restored along with its parent.",
      ],
    }
  }

  const { data: claimed, error: claimErr } = await supabase.rpc(
    "claim_deleted_item",
    { p_id: parsed.id }
  )
  if (claimErr) throw new Error(claimErr.message)
  if (!claimed || claimed.length === 0) {
    return { restored: false, alreadyBack: true, warnings: ["Already restored."] }
  }

  const payload = entry.payload as unknown as TrashPayload
  const warnings: string[] = []
  let restoredIds: string[] = []
  try {
    switch (entry.entity_type) {
      case "work_item":
      case "todo":
        restoredIds = await restoreScheduleItemTree(
          supabase,
          parsed.project_id,
          entry.entity_id,
          payload,
          profile.id,
          warnings
        )
        break
      case "change_order":
      case "selection":
        restoredIds = await restoreDecision(
          supabase,
          parsed.project_id,
          payload,
          profile.id,
          warnings
        )
        break
      case "daily_log":
        restoredIds = await restoreDailyLog(supabase, payload, profile.id, warnings)
        break
      case "file":
        restoredIds = await restoreProjectFile(supabase, payload, warnings)
        break
      case "bid_package":
        restoredIds = await restoreBidPackage(
          supabase,
          parsed.project_id,
          payload,
          warnings
        )
        break
      case "purchase_order":
        restoredIds = await restorePurchaseOrder(
          supabase,
          parsed.project_id,
          payload,
          warnings
        )
        break
    }
  } catch (e) {
    // Release the claim so the entry stays restorable after the user fixes
    // whatever blocked it (child-row problems never land here — only a
    // failed main-row insert does).
    await supabase.rpc("unclaim_deleted_item", { p_id: parsed.id })
    throw e instanceof Error ? e : new Error(String(e))
  }

  // Claim any overlapping entries whose entity came back inside this restore
  // (e.g. a to-do bulk-deleted alongside its parent work item).
  if (restoredIds.length > 0) {
    await supabase.rpc("claim_restored_entities", {
      p_project: parsed.project_id,
      p_entity_ids: restoredIds,
    })
  }

  const section = PATH_FOR_TYPE[entry.entity_type]
  if (section) revalidatePath(`/projects/${parsed.project_id}/${section}`)
  revalidatePath(`/projects/${parsed.project_id}/history`)

  return { restored: true, warnings }
}

/**
 * Drop trash entries past the 30-day retention and remove the Storage
 * objects of entries that were never restored. Called lazily from the
 * History page; best-effort by design.
 */
export async function purgeExpiredTrash(projectId: string) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.rpc("purge_expired_deleted_items", {
    p_project: projectId,
  })
  if (error || !data) return
  const paths = data
    .filter((r) => !r.was_restored)
    .flatMap((r) => r.storage_paths ?? [])
  for (let i = 0; i < paths.length; i += 100) {
    await supabase.storage.from("project-files").remove(paths.slice(i, i + 100))
  }
}
