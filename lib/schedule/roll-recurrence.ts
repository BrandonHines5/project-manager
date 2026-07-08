import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/lib/db/types"
import { isRecurrenceRule, rollRecurrence } from "@/lib/schedule/recurrence"

type Client = SupabaseClient<Database>

// "Today" for the catch-up math in the COMPANY's timezone, not UTC — a daily
// to-do completed at 9pm Eastern is still "today" there but already tomorrow
// in UTC, and using the UTC date would skip the next occurrence. Hines Homes
// operates in Indiana; a fixed zone beats guessing from the request. (The
// en-CA locale formats as YYYY-MM-DD.)
function companyTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date())
}

/**
 * Roll-on-complete for recurring to-dos. Call AFTER a to-do has been marked
 * complete: if it carries a recurrence_rule, the rule is stripped off the
 * completed row (it stays behind as a plain completed to-do) and the next
 * occurrence is created as a fresh row — due date advanced per the rule,
 * checklist copied with is_done reset, assignments copied verbatim, and the
 * rule (count decremented) carried forward. Exactly one row of a series ever
 * holds the rule, so re-completing is naturally idempotent.
 *
 * Returns the new occurrence's id, null when there's nothing to roll (not
 * recurring, no due date to anchor from, series ended). Never throws — a roll
 * failure must not undo or mask the completion itself.
 *
 * `anchorDueOverride` exists for callers that rewrite due_date as part of
 * completing (the onsite quick-update flow) — pass the ORIGINAL due date so
 * the series cadence stays anchored.
 */
export async function rollRecurringTodo(
  supabase: Client,
  itemId: string,
  opts: { anchorDueOverride?: string | null } = {}
): Promise<string | null> {
  try {
    const { data: item, error } = await supabase
      .from("schedule_items")
      .select(
        "id, project_id, parent_id, kind, title, description, priority, due_date, recurrence_rule, created_by"
      )
      .eq("id", itemId)
      .maybeSingle()
    if (error || !item || item.kind !== "todo") return null
    const rule = item.recurrence_rule
    if (!isRecurrenceRule(rule)) return null
    const anchorDue = opts.anchorDueOverride ?? item.due_date
    // A rule without a due date has no anchor to advance from — leave it be.
    if (!anchorDue) return null

    // Compare-and-swap strip: only the request that actually nulls the rule
    // may create the next occurrence. A concurrent double-completion blocks on
    // the row lock, re-evaluates the NOT NULL predicate after the winner
    // commits, matches zero rows, and bails — so the series never forks.
    const { data: stripped, error: stripErr } = await supabase
      .from("schedule_items")
      .update({ recurrence_rule: null })
      .eq("id", item.id)
      .not("recurrence_rule", "is", null)
      .select("id")
    if (stripErr || (stripped ?? []).length !== 1) return null

    const rolled = rollRecurrence(rule, anchorDue, companyTodayISO())
    if (!rolled) return null // series ended (count exhausted / past `until`)

    const [{ data: checklist }, { data: assignments }] = await Promise.all([
      supabase
        .from("todo_checklist_items")
        .select(
          "label, position, assignee_profile_id, assignee_company_id, assignee_role_id"
        )
        .eq("schedule_item_id", item.id)
        .order("position", { ascending: true }),
      supabase
        .from("schedule_assignments")
        .select("profile_id, company_id, role_id")
        .eq("schedule_item_id", item.id),
    ])

    const { data: next, error: insErr } = await supabase
      .from("schedule_items")
      .insert({
        project_id: item.project_id,
        parent_id: item.parent_id,
        kind: "todo",
        title: item.title,
        description: item.description,
        priority: item.priority,
        due_date: rolled.nextDue,
        recurrence_rule: rolled.nextRule as unknown as Json,
        status: "not_started",
        created_by: item.created_by,
      })
      .select("id")
      .single()
    if (insErr || !next) return null

    if (checklist?.length) {
      const { error: clErr } = await supabase.from("todo_checklist_items").insert(
        checklist.map((c, i) => ({
          schedule_item_id: next.id,
          label: c.label,
          is_done: false,
          position: i,
          assignee_profile_id: c.assignee_profile_id,
          assignee_company_id: c.assignee_company_id,
          assignee_role_id: c.assignee_role_id,
        }))
      )
      if (clErr) {
        console.warn("[rollRecurringTodo] checklist copy failed:", clErr.message)
      }
    }

    const assignmentRows = (assignments ?? []).filter(
      (a) => a.profile_id || a.company_id || a.role_id
    )
    if (assignmentRows.length) {
      const { error: asErr } = await supabase.from("schedule_assignments").insert(
        assignmentRows.map((a) => ({
          schedule_item_id: next.id,
          profile_id: a.profile_id,
          company_id: a.company_id,
          role_id: a.role_id,
        }))
      )
      if (asErr) {
        console.warn("[rollRecurringTodo] assignment copy failed:", asErr.message)
      }
    }

    return next.id
  } catch (e) {
    console.warn("[rollRecurringTodo] failed:", e)
    return null
  }
}
