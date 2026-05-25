import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = typeof value === "string" ? new Date(value) : value
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

export function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  if (!start && !end) return "—"
  if (start && !end) return formatDate(start)
  if (!start && end) return formatDate(end)
  return `${formatDate(start)} – ${formatDate(end)}`
}

export function daysBetween(start: string, end: string): number {
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---- Business-day (Mon–Fri) helpers ---------------------------------------
// All inputs/outputs are ISO yyyy-mm-dd strings interpreted as calendar dates
// in UTC (which is what <input type="date"> emits). Saturday=6, Sunday=0.

function isWeekendUTC(d: Date): boolean {
  const dow = d.getUTCDay()
  return dow === 0 || dow === 6
}

/**
 * Advance `dateStr` forward to the next business day if it falls on a
 * weekend. A weekday is returned unchanged.
 */
export function nextBusinessDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z")
  while (isWeekendUTC(d)) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Add `n` business days to `dateStr`. n=0 returns the same date (snapped
 * forward to the next weekday if it was on a weekend). n=1 advances to the
 * next business day, etc.
 */
export function addBusinessDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z")
  while (isWeekendUTC(d)) d.setUTCDate(d.getUTCDate() + 1)
  let remaining = n
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (!isWeekendUTC(d)) remaining--
  }
  return d.toISOString().slice(0, 10)
}

/**
 * Inclusive business-day count from `start` to `end` (e.g. Mon→Fri = 5).
 * If start > end, returns 0.
 */
export function businessDaysBetween(start: string, end: string): number {
  if (start > end) return 0
  const s = new Date(start + "T00:00:00Z")
  const e = new Date(end + "T00:00:00Z")
  let count = 0
  for (let d = s; d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isWeekendUTC(d)) count++
  }
  return count
}

/**
 * end = start + (durationBusinessDays - 1). Inclusive: a 5-day item starting
 * Monday ends Friday.
 */
export function endDateFromDuration(
  start: string,
  durationBusinessDays: number
): string {
  if (durationBusinessDays <= 0) return start
  return addBusinessDays(nextBusinessDay(start), durationBusinessDays - 1)
}
