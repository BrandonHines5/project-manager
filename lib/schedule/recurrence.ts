// Recurring to-do rules, stored as `recurrence_rule` jsonb on schedule_items.
//
// ALL date math here is pure calendar-day arithmetic on YYYY-MM-DD strings,
// done in UTC via Date.UTC — never local-time parsing mixed with
// toISOString() output (the old library's timezone bug). Valid YYYY-MM-DD
// strings compare correctly with plain string comparison, which this module
// relies on throughout.

export type RecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly"

export type RecurrenceRule = {
  freq: RecurrenceFreq
  /** Default 1; e.g. weekly interval 2 = every 2 weeks. */
  interval?: number
  /** Inclusive YYYY-MM-DD end date. */
  until?: string
  /** Total occurrences REMAINING including the current one. */
  count?: number
}

const FREQS: readonly string[] = ["daily", "weekly", "biweekly", "monthly"]
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000
/** Hard cap on the monthly occurrence scan in rollRecurrence. */
const ROLL_ITERATION_CAP = 5000
/** Hard cap on monthly expansion iterations (~100 years at interval 1). */
const MONTHLY_EXPAND_CAP = 1200

type ParsedDate = { y: number; m: number; d: number; epochDay: number }

/** Strictly parse a YYYY-MM-DD string as a UTC calendar date. */
function parseISODate(iso: unknown): ParsedDate | null {
  if (typeof iso !== "string" || !ISO_DATE_RE.test(iso)) return null
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const ms = Date.UTC(y, m - 1, d)
  const dt = new Date(ms)
  // Round-trip check rejects calendar overflow like 2026-02-30.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null
  }
  return { y, m, d, epochDay: ms / MS_PER_DAY }
}

function formatYMD(y: number, m: number, d: number): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0")
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}

function formatEpochDay(epochDay: number): string {
  const dt = new Date(epochDay * MS_PER_DAY)
  return formatYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** Number of days in month `m` (1-based) of year `y`. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function normalizeInterval(interval: number | undefined): number {
  if (typeof interval !== "number" || !Number.isFinite(interval)) return 1
  return Math.max(1, Math.floor(interval))
}

/** Days per step for the linear frequencies; null for monthly/unknown. */
function stepDays(freq: RecurrenceFreq, interval: number): number | null {
  switch (freq) {
    case "daily":
      return interval
    case "weekly":
      return 7 * interval
    case "biweekly":
      return 14 * interval
    default:
      return null
  }
}

function monthIndex(d: ParsedDate): number {
  return d.y * 12 + (d.m - 1)
}

/**
 * Occurrence of a monthly series `monthsAhead` months after the anchor
 * (0 = the anchor itself). Keeps the ANCHOR's day-of-month, clamping to the
 * last day of shorter months PER OCCURRENCE (anchor Jan 31 → Feb 28, Mar 31,
 * Apr 30, …). Computed from the anchor every time — never chained setMonth —
 * so there is no overflow drift.
 */
function monthlyOccurrence(anchor: ParsedDate, monthsAhead: number): string {
  const mi = monthIndex(anchor) + monthsAhead
  const y = Math.floor(mi / 12)
  const m = (mi % 12) + 1
  return formatYMD(y, m, Math.min(anchor.d, daysInMonth(y, m)))
}

/**
 * `until` if it parses as a real YYYY-MM-DD date, else undefined —
 * rollRecurrence/expandRecurrence treat an invalid `until` as absent.
 */
function validUntil(rule: RecurrenceRule): string | undefined {
  return parseISODate(rule.until) ? rule.until : undefined
}

/** Finite occurrence budget from `count`, or Infinity when unset/invalid. */
function normalizeCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return Infinity
  return Math.floor(count)
}

export function isRecurrenceRule(v: unknown): v is RecurrenceRule {
  if (typeof v !== "object" || v === null) return false
  const r = v as { freq?: unknown; until?: unknown }
  if (typeof r.freq !== "string" || !FREQS.includes(r.freq)) return false
  if (r.until !== undefined) {
    if (typeof r.until !== "string" || !ISO_DATE_RE.test(r.until)) return false
  }
  return true
}

export function describeRecurrence(rule: RecurrenceRule): string {
  const interval = normalizeInterval(rule.interval)
  let base: string
  switch (rule.freq) {
    case "daily":
      base = interval > 1 ? `Daily (every ${interval} days)` : "Daily"
      break
    case "weekly":
      base = interval > 1 ? `Weekly (every ${interval} weeks)` : "Weekly"
      break
    case "biweekly":
      base = interval > 1 ? `Every ${2 * interval} weeks` : "Every 2 weeks"
      break
    default:
      base = interval > 1 ? `Monthly (every ${interval} months)` : "Monthly"
      break
  }
  // `count` = occurrences remaining; it takes precedence over `until`.
  const count = normalizeCount(rule.count)
  if (Number.isFinite(count) && count >= 1) {
    return count === 1 ? `${base}, once more` : `${base}, ${count} more times`
  }
  if (rule.until) return `${base}, until ${rule.until}`
  return base
}

/**
 * Called when a recurring to-do is completed. anchorDueISO = the completed
 * occurrence's due date (the series anchor); todayISO = completion date.
 * Returns the next occurrence's due date + the rule to store on it, or null
 * when the series has ended (count exhausted, or next date past `until`).
 *
 * Catch-up: candidates are occurrence k >= 1 after the anchor, and the next
 * due date is the smallest candidate STRICTLY greater than
 * max(anchorDueISO, todayISO) — if the to-do sat overdue for weeks, the
 * missed slots are skipped but the cadence stays aligned to the anchor.
 */
export function rollRecurrence(
  rule: RecurrenceRule,
  anchorDueISO: string,
  todayISO: string
): { nextDue: string; nextRule: RecurrenceRule } | null {
  const anchor = parseISODate(anchorDueISO)
  if (!anchor) return null

  // `count` includes the occurrence just completed, so <= 1 means it was
  // the last one.
  if (
    typeof rule.count === "number" &&
    Number.isFinite(rule.count) &&
    rule.count <= 1
  ) {
    return null
  }

  const interval = normalizeInterval(rule.interval)
  const until = validUntil(rule)
  const today = parseISODate(todayISO)
  const threshold = today && today.epochDay > anchor.epochDay ? today : anchor

  let nextDue: string | null = null
  if (rule.freq === "monthly") {
    const thresholdISO = formatYMD(threshold.y, threshold.m, threshold.d)
    // Skip near the threshold instead of walking month-by-month from the
    // anchor (k below is a safe underestimate of the answer's index).
    const monthsAhead = monthIndex(threshold) - monthIndex(anchor)
    let k = Math.max(1, Math.floor((monthsAhead - 1) / interval))
    for (let i = 0; i < ROLL_ITERATION_CAP; i++, k++) {
      const occ = monthlyOccurrence(anchor, k * interval)
      if (occ > thresholdISO) {
        nextDue = occ
        break
      }
    }
  } else {
    const step = stepDays(rule.freq, interval)
    if (step == null) return null
    const diff = threshold.epochDay - anchor.epochDay
    const k = Math.max(1, Math.floor(diff / step) + 1)
    nextDue = formatEpochDay(anchor.epochDay + k * step)
  }

  if (nextDue == null) return null
  if (until && nextDue > until) return null

  const nextRule: RecurrenceRule = { ...rule }
  if (typeof rule.count === "number" && Number.isFinite(rule.count)) {
    nextRule.count = rule.count - 1
  } else {
    // Omit the key entirely rather than storing `count: undefined`.
    delete nextRule.count
  }
  return { nextDue, nextRule }
}

/**
 * Every occurrence date in [rangeStart, rangeEnd] inclusive, INCLUDING the
 * anchor itself when it falls in range. Respects `until` (inclusive) and
 * `count` (occurrences from the anchor; the anchor is #1 — occurrences
 * before the window still consume the budget). Correct for windows far in
 * the future: linear frequencies skip directly to the first candidate in
 * range via integer division, and monthly skips by month index with a hard
 * iteration cap.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  anchorISO: string,
  rangeStart: string,
  rangeEnd: string
): string[] {
  const anchor = parseISODate(anchorISO)
  const rs = parseISODate(rangeStart)
  const re = parseISODate(rangeEnd)
  if (!anchor || !rs || !re) return []

  const interval = normalizeInterval(rule.interval)
  const until = validUntil(rule)
  // Effective inclusive end of the window.
  const end = until && until < rangeEnd ? until : rangeEnd
  const count = normalizeCount(rule.count)
  if (count <= 0) return []

  const out: string[] = []

  if (rule.freq === "monthly") {
    const monthsAhead = monthIndex(rs) - monthIndex(anchor)
    // Safe underestimate of the first in-range occurrence index.
    let k = Math.max(0, Math.floor((monthsAhead - 1) / interval))
    for (let i = 0; i < MONTHLY_EXPAND_CAP; i++, k++) {
      if (k >= count) break
      const occ = monthlyOccurrence(anchor, k * interval)
      if (occ > end) break
      if (occ >= rangeStart) out.push(occ)
    }
    return out
  }

  const step = stepDays(rule.freq, interval)
  if (step == null) return []
  // First occurrence index at or after rangeStart.
  const first = Math.max(0, Math.ceil((rs.epochDay - anchor.epochDay) / step))
  for (let k = first; k < count; k++) {
    const occ = formatEpochDay(anchor.epochDay + k * step)
    if (occ > end) break
    out.push(occ)
  }
  return out
}
