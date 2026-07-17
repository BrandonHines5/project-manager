import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Enums } from "@/lib/db/types"
import { addDays, formatDate, todayISO } from "@/lib/utils"

export type OnsitePromptTrigger =
  | "past_due"
  | "ending_today"
  | "starting_today"
  | "upcoming_unstarted"
  | "todo_past_due"
  | "todo_due_today"

// A sub/vendor the staffer can text about this item, resolved from the
// item's SAVED assignments: a directly-assigned company, or the company
// filling an assigned ROLE on this project. The server action
// (sendQuoTextToSub) re-resolves and re-verifies the assignment — this list
// is just UX.
export type OnsiteTextRecipient = {
  key: string
  label: string
  companyName: string
  phone: string | null
  target:
    | { kind: "company"; company_id: string }
    | { kind: "role"; role_id: string }
}

export type OnsitePrompt = {
  id: string
  title: string
  kind: Enums<"schedule_item_kind">
  status: Enums<"schedule_item_status">
  trigger: OnsitePromptTrigger
  start_date: string | null
  end_date: string | null
  due_date: string | null
  question: string
  recipients: OnsiteTextRecipient[]
}

const MAX_PROMPTS = 20

// Priority ordering — the first trigger a row matches (in this list) wins,
// so a past-due item never gets demoted to "upcoming" just because both
// criteria technically hit.
const TRIGGER_PRIORITY: OnsitePromptTrigger[] = [
  "past_due",
  "todo_past_due",
  "ending_today",
  "todo_due_today",
  "starting_today",
  "upcoming_unstarted",
]

export async function getOnsitePrompts(
  supabase: SupabaseClient<Database>,
  projectId: string
): Promise<OnsitePrompt[]> {
  const today = todayISO()
  const twoDaysOut = addDays(today, 2)

  // Single fetch covers all triggers. We tag the trigger per-row in JS
  // rather than running separate queries — the result set is small (a
  // project's open items rarely exceed a few dozen) so this is cheaper
  // than the round-trip per rule.
  //
  // Work items live on start_date/end_date; to-dos live on due_date. The
  // OR clause covers both shapes; classify() picks the right trigger
  // based on which column was populated.
  const { data, error } = await supabase
    .from("schedule_items")
    .select(
      "id, title, kind, status, start_date, end_date, due_date"
    )
    .eq("project_id", projectId)
    .or(
      [
        // Work items: past due or ending today.
        `and(end_date.lte.${today},status.neq.complete)`,
        // Work items: starting today, not yet started.
        `and(start_date.eq.${today},status.eq.not_started)`,
        // Work items: starting in (today, today+2], not yet started.
        `and(start_date.gt.${today},start_date.lte.${twoDaysOut},status.eq.not_started)`,
        // To-dos: due today or earlier and not complete.
        `and(kind.eq.todo,due_date.lte.${today},status.neq.complete)`,
      ].join(",")
    )

  if (error) throw new Error(`Onsite prompt query failed: ${error.message}`)

  const rows = data ?? []
  const prompts: OnsitePrompt[] = []
  for (const row of rows) {
    const trigger = classify(row, today, twoDaysOut)
    if (!trigger) continue
    prompts.push({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      trigger,
      start_date: row.start_date,
      end_date: row.end_date,
      due_date: row.due_date,
      question: buildQuestion(row.title, trigger, row),
      recipients: [],
    })
  }

  // Sort by trigger priority, then by oldest due/end date so the most
  // urgent items are at the top of the list.
  prompts.sort((a, b) => {
    const pa = TRIGGER_PRIORITY.indexOf(a.trigger)
    const pb = TRIGGER_PRIORITY.indexOf(b.trigger)
    if (pa !== pb) return pa - pb
    const aDate = a.end_date ?? a.due_date ?? a.start_date ?? ""
    const bDate = b.end_date ?? b.due_date ?? b.start_date ?? ""
    return aDate.localeCompare(bDate)
  })

  const kept = prompts.slice(0, MAX_PROMPTS)
  await attachTextRecipients(supabase, projectId, kept)
  return kept
}

/**
 * Resolves the textable sub/vendor per prompt from its saved assignments —
 * a directly-assigned company, or the company filling an assigned role on
 * this project (mirrors the schedule dialog's "Send text to sub"). Only for
 * the prompts actually shown, so this is a handful of small queries.
 */
async function attachTextRecipients(
  supabase: SupabaseClient<Database>,
  projectId: string,
  prompts: OnsitePrompt[]
): Promise<void> {
  if (prompts.length === 0) return
  const itemIds = prompts.map((p) => p.id)
  const { data: assignments } = await supabase
    .from("schedule_assignments")
    .select("schedule_item_id, company_id, role_id")
    .in("schedule_item_id", itemIds)
  if (!assignments || assignments.length === 0) return

  const roleIds = Array.from(
    new Set(assignments.map((a) => a.role_id).filter((v): v is string => !!v))
  )
  const [{ data: roles }, { data: roleMembers }] = await Promise.all([
    roleIds.length
      ? supabase.from("roles").select("id, name").in("id", roleIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    roleIds.length
      ? supabase
          .from("project_role_members")
          .select("role_id, company_id")
          .eq("project_id", projectId)
          .in("role_id", roleIds)
      : Promise.resolve({
          data: [] as { role_id: string; company_id: string | null }[],
        }),
  ])
  const roleName = new Map((roles ?? []).map((r) => [r.id, r.name]))
  const roleCompany = new Map(
    (roleMembers ?? []).map((m) => [m.role_id, m.company_id])
  )

  const companyIds = new Set<string>()
  for (const a of assignments) {
    if (a.company_id) companyIds.add(a.company_id)
    if (a.role_id) {
      const cid = roleCompany.get(a.role_id)
      if (cid) companyIds.add(cid)
    }
  }
  if (companyIds.size === 0) return
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, phone, type")
    .in("id", Array.from(companyIds))
  const companyById = new Map((companies ?? []).map((c) => [c.id, c]))

  const byItem = new Map<string, typeof assignments>()
  for (const a of assignments) {
    const list = byItem.get(a.schedule_item_id) ?? []
    list.push(a)
    byItem.set(a.schedule_item_id, list)
  }

  for (const prompt of prompts) {
    const list = byItem.get(prompt.id) ?? []
    const seen = new Set<string>()
    // Direct company assignments first — they win the dedupe against a role
    // resolving to the same company.
    for (const a of list) {
      if (!a.company_id) continue
      const c = companyById.get(a.company_id)
      if (!c || c.type === "client" || seen.has(c.id)) continue
      seen.add(c.id)
      prompt.recipients.push({
        key: `company:${c.id}`,
        label: c.name,
        companyName: c.name,
        phone: c.phone,
        target: { kind: "company", company_id: c.id },
      })
    }
    for (const a of list) {
      if (!a.role_id) continue
      const cid = roleCompany.get(a.role_id)
      const c = cid ? companyById.get(cid) : undefined
      // Role unfilled or filled by staff/client — no SMS target.
      if (!c || c.type === "client" || seen.has(c.id)) continue
      seen.add(c.id)
      prompt.recipients.push({
        key: `role:${a.role_id}`,
        label: `${c.name} · ${roleName.get(a.role_id) ?? "Role"}`,
        companyName: c.name,
        phone: c.phone,
        target: { kind: "role", role_id: a.role_id },
      })
    }
  }
}

function classify(
  row: {
    kind: Enums<"schedule_item_kind">
    start_date: string | null
    end_date: string | null
    due_date: string | null
    status: Enums<"schedule_item_status">
  },
  today: string,
  twoDaysOut: string
): OnsitePromptTrigger | null {
  if (row.kind === "todo") {
    if (row.due_date && row.status !== "complete") {
      if (row.due_date < today) return "todo_past_due"
      if (row.due_date === today) return "todo_due_today"
    }
    return null
  }
  // Work items.
  if (row.end_date && row.status !== "complete") {
    if (row.end_date < today) return "past_due"
    if (row.end_date === today) return "ending_today"
  }
  if (row.start_date && row.status === "not_started") {
    if (row.start_date === today) return "starting_today"
    if (row.start_date > today && row.start_date <= twoDaysOut) {
      return "upcoming_unstarted"
    }
  }
  return null
}

function buildQuestion(
  title: string,
  trigger: OnsitePromptTrigger,
  row: {
    start_date: string | null
    end_date: string | null
    due_date: string | null
  }
): string {
  switch (trigger) {
    case "ending_today":
      return `${title} is scheduled to finish today. Will it complete today?`
    case "past_due":
      return `${title} was scheduled to finish ${formatDate(
        row.end_date
      )}. When did it / will it complete?`
    case "starting_today":
      return `${title} is scheduled to start today. Did it start?`
    case "upcoming_unstarted":
      return `${title} is scheduled to start ${formatDate(
        row.start_date
      )} but hasn't started yet. Still on track?`
    case "todo_due_today":
      return `${title} is due today. Done?`
    case "todo_past_due":
      return `${title} was due ${formatDate(
        row.due_date
      )}. When did it / will it get done?`
  }
}
