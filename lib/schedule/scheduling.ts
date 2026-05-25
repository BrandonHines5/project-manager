import { addDays } from "@/lib/utils"
import type { Tables } from "@/lib/db/types"

type ScheduleItem = Tables<"schedule_items">
type Predecessor = Tables<"schedule_predecessors">

/**
 * Walks the predecessor graph to detect a cycle if we were to add
 * (item_id, predecessor_id). Returns true if adding would create a cycle.
 */
export function wouldCreateCycle(
  predecessors: Predecessor[],
  itemId: string,
  predecessorId: string
): boolean {
  if (itemId === predecessorId) return true
  const successorsOf = new Map<string, string[]>()
  for (const p of predecessors) {
    const arr = successorsOf.get(p.predecessor_id) ?? []
    arr.push(p.item_id)
    successorsOf.set(p.predecessor_id, arr)
  }
  // Walk forward from itemId: if we ever reach predecessorId, cycle exists.
  const stack = [itemId]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    if (cur === predecessorId) return true
    const nexts = successorsOf.get(cur) ?? []
    stack.push(...nexts)
  }
  return false
}

/**
 * Given a moved item and the full predecessor + item graph, returns a list of
 * { id, start_date, end_date } updates that should cascade for FS dependencies.
 * Only FS/SS/FF/SF are considered minimally; the v1 algorithm is "earliest start"
 * after the predecessor's end + lag, preserving duration.
 */
export function cascadeFromPredecessors(
  items: ScheduleItem[],
  predecessors: Predecessor[],
  movedId: string
): Array<{ id: string; start_date: string; end_date: string }> {
  const byId = new Map(items.map((i) => [i.id, i]))
  const successorsOf = new Map<string, Predecessor[]>()
  for (const p of predecessors) {
    const arr = successorsOf.get(p.predecessor_id) ?? []
    arr.push(p)
    successorsOf.set(p.predecessor_id, arr)
  }

  const updates: Array<{ id: string; start_date: string; end_date: string }> = []
  const queue: string[] = [movedId]
  const visited = new Set<string>()

  while (queue.length) {
    const curId = queue.shift()!
    if (visited.has(curId)) continue
    visited.add(curId)

    const cur = byId.get(curId)
    if (!cur || !cur.start_date || !cur.end_date) continue

    const successors = successorsOf.get(curId) ?? []
    for (const succLink of successors) {
      const succ = byId.get(succLink.item_id)
      if (!succ || !succ.start_date || !succ.end_date) continue
      const lag = succLink.lag_days ?? 0

      let newStart = succ.start_date
      if (succLink.dep_type === "FS") {
        newStart = addDays(cur.end_date, 1 + lag)
      } else if (succLink.dep_type === "SS") {
        newStart = addDays(cur.start_date, lag)
      } else if (succLink.dep_type === "FF") {
        const succDuration = daysBetween(succ.start_date, succ.end_date)
        const newEnd = addDays(cur.end_date, lag)
        newStart = addDays(newEnd, -(succDuration - 1))
      } else if (succLink.dep_type === "SF") {
        const succDuration = daysBetween(succ.start_date, succ.end_date)
        const newEnd = addDays(cur.start_date, lag)
        newStart = addDays(newEnd, -(succDuration - 1))
      }

      if (newStart > succ.start_date) {
        const duration = daysBetween(succ.start_date, succ.end_date)
        const newEnd = addDays(newStart, duration - 1)
        updates.push({ id: succ.id, start_date: newStart, end_date: newEnd })
        byId.set(succ.id, { ...succ, start_date: newStart, end_date: newEnd })
        queue.push(succ.id)
      }
    }
  }
  return updates
}

function daysBetween(a: string, b: string): number {
  const ad = new Date(a).getTime()
  const bd = new Date(b).getTime()
  return Math.round((bd - ad) / (1000 * 60 * 60 * 24)) + 1
}

/**
 * For a to-do anchored to a parent work item, compute the due_date from the
 * parent's chosen anchor (start or end) plus a signed day offset. Returns
 * null when the parent hasn't been scheduled yet (caller stores null due_date
 * and the cascade will fill it in later when the parent gets dates).
 */
export function recomputeAnchoredDueDate(
  parent: Pick<ScheduleItem, "start_date" | "end_date">,
  anchor: "start" | "end",
  offsetDays: number
): string | null {
  const basis = anchor === "start" ? parent.start_date : parent.end_date
  if (!basis) return null
  return addDays(basis, offsetDays)
}
