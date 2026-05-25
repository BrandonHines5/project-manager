import { addDays as fnsAddDays, isAfter, isBefore, isSameDay, parseISO } from "date-fns"

export type RecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly"

export type RecurrenceRule = {
  freq: RecurrenceFreq
  interval?: number
  until?: string
  count?: number
  byweekday?: number[]
}

export function isRecurrenceRule(v: unknown): v is RecurrenceRule {
  if (!v || typeof v !== "object") return false
  const r = v as RecurrenceRule
  return ["daily", "weekly", "biweekly", "monthly"].includes(r.freq)
}

export function expandRecurrence(
  rule: RecurrenceRule,
  anchorISO: string,
  rangeStart: string,
  rangeEnd: string
): string[] {
  const anchor = parseISO(anchorISO)
  const start = parseISO(rangeStart)
  const end = parseISO(rangeEnd)
  const until = rule.until ? parseISO(rule.until) : null
  const limit = rule.count ?? 365
  const interval = Math.max(1, rule.interval ?? 1)

  const out: string[] = []
  let cursor = new Date(anchor)
  let generated = 0

  const stepDays =
    rule.freq === "daily" ? 1 * interval :
    rule.freq === "weekly" ? 7 * interval :
    rule.freq === "biweekly" ? 14 * interval :
    0

  if (rule.freq === "monthly") {
    for (let i = 0; i < limit; i++) {
      if (until && isAfter(cursor, until)) break
      if (isAfter(cursor, end)) break
      if (!isBefore(cursor, start) || isSameDay(cursor, start)) {
        out.push(cursor.toISOString().slice(0, 10))
      }
      const next = new Date(cursor)
      next.setMonth(next.getMonth() + interval)
      cursor = next
      generated++
      if (generated >= limit) break
    }
    return out
  }

  for (let i = 0; i < limit; i++) {
    if (until && isAfter(cursor, until)) break
    if (isAfter(cursor, end)) break
    if (!isBefore(cursor, start) || isSameDay(cursor, start)) {
      out.push(cursor.toISOString().slice(0, 10))
    }
    cursor = fnsAddDays(cursor, stepDays)
  }
  return out
}

export function describeRecurrence(rule: RecurrenceRule): string {
  const interval = rule.interval ?? 1
  const base =
    rule.freq === "daily" ? `Daily${interval > 1 ? ` (every ${interval} days)` : ""}` :
    rule.freq === "weekly" ? `Weekly${interval > 1 ? ` (every ${interval} weeks)` : ""}` :
    rule.freq === "biweekly" ? "Every 2 weeks" :
    `Monthly${interval > 1 ? ` (every ${interval} months)` : ""}`
  if (rule.count) return `${base}, ${rule.count} times`
  if (rule.until) return `${base}, until ${rule.until}`
  return base
}
