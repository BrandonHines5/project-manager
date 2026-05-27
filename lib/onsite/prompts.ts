import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Enums } from "@/lib/db/types"
import { addDays, formatDate, todayISO } from "@/lib/utils"

export type OnsitePromptTrigger =
  | "past_due"
  | "ending_today"
  | "starting_today"
  | "upcoming_unstarted"

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
}

const MAX_PROMPTS = 15

// Priority ordering — the first trigger a row matches (in this list) wins,
// so a past-due item never gets demoted to "upcoming" just because both
// criteria technically hit.
const TRIGGER_PRIORITY: OnsitePromptTrigger[] = [
  "past_due",
  "ending_today",
  "starting_today",
  "upcoming_unstarted",
]

export async function getOnsitePrompts(
  supabase: SupabaseClient<Database>,
  projectId: string
): Promise<OnsitePrompt[]> {
  const today = todayISO()
  const twoDaysOut = addDays(today, 2)

  // Single fetch covers all four triggers. We tag the trigger per-row in JS
  // rather than running four separate queries — the result set is small (a
  // project's open work items rarely exceed a few dozen) so this is cheaper
  // than the round-trip per rule.
  const { data, error } = await supabase
    .from("schedule_items")
    .select(
      "id, title, kind, status, start_date, end_date, due_date"
    )
    .eq("project_id", projectId)
    .or(
      [
        // Past due or ending today: end_date <= today AND status != complete.
        `and(end_date.lte.${today},status.neq.complete)`,
        // Starting today: start_date = today AND not yet started.
        `and(start_date.eq.${today},status.eq.not_started)`,
        // Upcoming unstarted: start_date in (today, today+2] AND not_started.
        `and(start_date.gt.${today},start_date.lte.${twoDaysOut},status.eq.not_started)`,
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
    })
  }

  // Sort by trigger priority, then by oldest end_date / earliest start_date
  // so the most urgent items are at the top of the list.
  prompts.sort((a, b) => {
    const pa = TRIGGER_PRIORITY.indexOf(a.trigger)
    const pb = TRIGGER_PRIORITY.indexOf(b.trigger)
    if (pa !== pb) return pa - pb
    const aDate = a.end_date ?? a.start_date ?? ""
    const bDate = b.end_date ?? b.start_date ?? ""
    return aDate.localeCompare(bDate)
  })

  return prompts.slice(0, MAX_PROMPTS)
}

function classify(
  row: {
    start_date: string | null
    end_date: string | null
    status: Enums<"schedule_item_status">
  },
  today: string,
  twoDaysOut: string
): OnsitePromptTrigger | null {
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
  row: { start_date: string | null; end_date: string | null }
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
  }
}
