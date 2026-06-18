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


/**
 * Critical path = the single longest chain of dependency-linked work items.
 *
 * We deliberately do NOT use classic zero-float CPM here. On a hand-scheduled
 * plan where the stored dates carry slack/gaps (very common — tasks are placed
 * on the calendar with breathing room, not packed tight against their
 * predecessors), zero-float CPM collapses to just the latest-finishing item
 * and reports everything else as non-critical. Builders read the critical path
 * as "the spine of sequential work that runs longest end to end", so that's
 * what we surface: the longest connected chain through the predecessor graph.
 *
 * Path length = sum of each task's duration (inclusive days) + the lag on each
 * connecting edge. We walk the DAG in topological order, track the longest
 * length ending at each item and the edge we arrived by, then reconstruct the
 * winning chain back from its endpoint.
 *
 * Notes:
 *   - Only dated, non-recurring work items that aren't flagged
 *     `exclude_from_critical_path` participate.
 *   - Dependency type doesn't change chain membership — any predecessor edge
 *     links two tasks — but the edge lag still counts toward path length.
 *   - Operates on epoch-day numbers (UTC midnight / 86400000).
 *   - Returns an empty set on a cycle (defense in depth — cycles are blocked at
 *     save time, but a stale dataset shouldn't crash the renderer).
 */
export function computeLongestChain(
  items: ScheduleItem[],
  predecessors: Predecessor[]
): Set<string> {
  const workItems = items.filter(
    (i) =>
      i.kind === "work" &&
      i.start_date &&
      i.end_date &&
      !i.recurrence_parent_id &&
      !i.exclude_from_critical_path
  )
  if (workItems.length === 0) return new Set()

  const toEpochDay = (iso: string) =>
    Math.round(new Date(iso).getTime() / 86400000)

  const byId = new Map<string, ScheduleItem>(workItems.map((i) => [i.id, i]))
  const duration = new Map<string, number>()
  for (const it of workItems) {
    const s = toEpochDay(it.start_date!)
    const e = toEpochDay(it.end_date!)
    duration.set(it.id, Math.max(1, e - s + 1))
  }

  const incoming = new Map<string, Predecessor[]>()
  const outgoing = new Map<string, Predecessor[]>()
  for (const p of predecessors) {
    if (!byId.has(p.item_id) || !byId.has(p.predecessor_id)) continue
    if (!incoming.has(p.item_id)) incoming.set(p.item_id, [])
    if (!outgoing.has(p.predecessor_id)) outgoing.set(p.predecessor_id, [])
    incoming.get(p.item_id)!.push(p)
    outgoing.get(p.predecessor_id)!.push(p)
  }

  // Topological order via Kahn's algorithm.
  const inDeg = new Map<string, number>(
    workItems.map((i) => [i.id, incoming.get(i.id)?.length ?? 0])
  )
  const queue: string[] = []
  for (const [id, deg] of inDeg) if (deg === 0) queue.push(id)
  const order: string[] = []
  while (queue.length) {
    const cur = queue.shift()!
    order.push(cur)
    for (const out of outgoing.get(cur) ?? []) {
      const next = out.item_id
      const d = (inDeg.get(next) ?? 0) - 1
      inDeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (order.length !== workItems.length) return new Set() // cycle

  // Longest path by duration (+ edge lag). best[id] = longest length of a
  // chain ending at id; prevOf[id] = the predecessor we arrived from on that
  // longest chain (null when id begins its own chain).
  const best = new Map<string, number>()
  const prevOf = new Map<string, string | null>()
  for (const id of order) {
    const dur = duration.get(id)!
    let bestLen = dur
    let bestPrev: string | null = null
    for (const p of incoming.get(id) ?? []) {
      const cand = (best.get(p.predecessor_id) ?? 0) + p.lag_days + dur
      if (cand > bestLen) {
        bestLen = cand
        bestPrev = p.predecessor_id
      }
    }
    best.set(id, bestLen)
    prevOf.set(id, bestPrev)
  }

  // Endpoint of the overall longest chain, then walk the prev pointers back.
  let endId: string | null = null
  let endLen = Number.NEGATIVE_INFINITY
  for (const [id, len] of best) {
    if (len > endLen) {
      endLen = len
      endId = id
    }
  }
  const chain = new Set<string>()
  let cur: string | null = endId
  while (cur) {
    chain.add(cur)
    cur = prevOf.get(cur) ?? null
  }
  return chain
}

/**
 * The critical path the UI highlights — the longest dependency chain. Thin
 * wrapper kept for existing call sites (the schedule list's "Next N critical
 * items" panel).
 */
export function computeCriticalPath(
  items: ScheduleItem[],
  predecessors: Predecessor[]
): Set<string> {
  return computeLongestChain(items, predecessors)
}

/**
 * Richer payload for the Gantt:
 *   - critical: the longest dependency chain (see computeLongestChain).
 *   - floatDays: not used under the longest-chain model; kept in the return
 *     shape (always empty) so callers don't have to change.
 *   - projectFinishEpochDay: the latest end date across the considered work
 *     items — the actual finish shown on the calendar. Multiply by 86400000
 *     to convert back to an ISO date for display.
 */
export type ScheduleAnalysis = {
  critical: Set<string>
  floatDays: Map<string, number>
  projectFinishEpochDay: number | null
}

export function computeScheduleAnalysis(
  items: ScheduleItem[],
  predecessors: Predecessor[]
): ScheduleAnalysis {
  const workItems = items.filter(
    (i) =>
      i.kind === "work" &&
      i.start_date &&
      i.end_date &&
      !i.recurrence_parent_id &&
      !i.exclude_from_critical_path
  )
  if (workItems.length === 0)
    return {
      critical: new Set(),
      floatDays: new Map(),
      projectFinishEpochDay: null,
    }

  const toEpochDay = (iso: string) =>
    Math.round(new Date(iso).getTime() / 86400000)
  let projectFinishEpochDay = Number.NEGATIVE_INFINITY
  for (const it of workItems) {
    const e = toEpochDay(it.end_date!)
    if (e > projectFinishEpochDay) projectFinishEpochDay = e
  }

  return {
    critical: computeLongestChain(items, predecessors),
    floatDays: new Map(),
    projectFinishEpochDay,
  }
}
