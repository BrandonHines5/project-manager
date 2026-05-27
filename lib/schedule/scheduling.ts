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
 * Critical Path Method on scheduled work items.
 *
 * Returns the set of work-item IDs that have zero slack — i.e. items where
 * pushing the start date by one day would push the whole project's end date
 * by one day. Standard CPM:
 *   - Forward pass: ES = max(predecessor EF + lag) across all dep types
 *     (FS uses pred.EF, SS uses pred.ES, FF/SF use the corresponding edges).
 *     EF = ES + duration - 1 (days are inclusive).
 *   - Backward pass: LF = min(successor LS-equivalent), LS = LF - duration + 1.
 *   - slack = LS - ES; critical if slack == 0.
 *
 * Implementation notes:
 *   - Operates on epoch-day numbers (UTC midnight / 86400000) so we don't have
 *     to convert back and forth from ISO strings inside the loop.
 *   - Skips items missing dates. They can't be on the critical path because
 *     they aren't on the calendar.
 *   - Returns an empty set on cycles (defense in depth — cycles are blocked at
 *     save time, but a stale dataset shouldn't crash the renderer).
 */
export function computeCriticalPath(
  items: ScheduleItem[],
  predecessors: Predecessor[]
): Set<string> {
  const workItems = items.filter(
    (i) =>
      i.kind === "work" &&
      i.start_date &&
      i.end_date &&
      !i.recurrence_parent_id
  )
  if (workItems.length === 0) return new Set()

  const toEpochDay = (iso: string) =>
    Math.round(new Date(iso).getTime() / 86400000)

  const byId = new Map<string, ScheduleItem>(
    workItems.map((i) => [i.id, i])
  )
  const incoming = new Map<string, Predecessor[]>()
  const outgoing = new Map<string, Predecessor[]>()
  for (const p of predecessors) {
    if (!byId.has(p.item_id) || !byId.has(p.predecessor_id)) continue
    if (!incoming.has(p.item_id)) incoming.set(p.item_id, [])
    if (!outgoing.has(p.predecessor_id)) outgoing.set(p.predecessor_id, [])
    incoming.get(p.item_id)!.push(p)
    outgoing.get(p.predecessor_id)!.push(p)
  }

  const duration = new Map<string, number>()
  for (const it of workItems) {
    const s = toEpochDay(it.start_date!)
    const e = toEpochDay(it.end_date!)
    duration.set(it.id, Math.max(1, e - s + 1))
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

  // Forward pass — propagate from each item's existing start to compute the
  // earliest its successors could start. When an item has no predecessors,
  // ES is taken straight from start_date so the algorithm anchors to the
  // user's calendar rather than re-baselining everything to day 0.
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  for (const id of order) {
    const it = byId.get(id)!
    const dur = duration.get(id)!
    let earliest = toEpochDay(it.start_date!)
    for (const p of incoming.get(id) ?? []) {
      const pred = byId.get(p.predecessor_id)!
      const predES = es.get(pred.id)!
      const predEF = ef.get(pred.id)!
      let candidate: number
      switch (p.dep_type) {
        case "FS":
          candidate = predEF + p.lag_days + 1
          break
        case "SS":
          candidate = predES + p.lag_days
          break
        case "FF":
          candidate = predEF + p.lag_days - dur + 1
          break
        case "SF":
          candidate = predES + p.lag_days - dur + 1
          break
        default:
          candidate = predEF + p.lag_days + 1
      }
      if (candidate > earliest) earliest = candidate
    }
    es.set(id, earliest)
    ef.set(id, earliest + dur - 1)
  }

  // Project finish = max EF across all items.
  const projectFinish = Math.max(...Array.from(ef.values()))

  // Backward pass.
  const lf = new Map<string, number>()
  const ls = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const dur = duration.get(id)!
    let latest = projectFinish
    const outs = outgoing.get(id) ?? []
    if (outs.length > 0) {
      latest = Infinity
      for (const p of outs) {
        const succLS = ls.get(p.item_id)!
        const succLF = lf.get(p.item_id)!
        let candidate: number
        switch (p.dep_type) {
          case "FS":
            // succ LS = pred LF + lag + 1, so pred LF = succ LS - lag - 1
            candidate = succLS - p.lag_days - 1
            break
          case "SS":
            // pred LS = succ LS - lag, pred LF = pred LS + dur - 1
            candidate = succLS - p.lag_days + dur - 1
            break
          case "FF":
            candidate = succLF - p.lag_days
            break
          case "SF":
            // Forward SF (above): succ.EF = pred.ES + lag.
            // Inverse: pred.ES_max = succ.LF - lag.
            // Then pred.LF = pred.LS_max + dur - 1
            //              = (succ.LF - lag) + dur - 1.
            candidate = succLF - p.lag_days + dur - 1
            break
          default:
            candidate = succLS - p.lag_days - 1
        }
        if (candidate < latest) latest = candidate
      }
    }
    lf.set(id, latest)
    ls.set(id, latest - dur + 1)
  }

  const critical = new Set<string>()
  for (const id of order) {
    if ((ls.get(id) ?? 0) - (es.get(id) ?? 0) === 0) {
      critical.add(id)
    }
  }
  return critical
}
