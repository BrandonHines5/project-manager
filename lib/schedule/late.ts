import { todayISO } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

/**
 * A schedule item is "late" when it's still open past its date: a work item
 * whose end_date is before today, or a to-do whose due_date is before today.
 * Same semantic as the projects dashboard's "past due" metric. Undated items
 * are never late. `today` defaults to todayISO(); pass one value when
 * rendering a list so every row agrees on the same day.
 */
export function isLateScheduleItem(
  item: {
    kind: Enums<"schedule_item_kind">
    status: Enums<"schedule_item_status">
    end_date: string | null
    due_date: string | null
  },
  today: string = todayISO()
): boolean {
  if (item.status === "complete") return false
  const date = item.kind === "work" ? item.end_date : item.due_date
  return date != null && date < today
}
