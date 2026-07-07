// Schedule health: how the tracked job duration (Job Start → Substantial
// Completion) compares to the locked baseline.
//
// The plan gets a 30-day buffer. While the duration has grown by ≤ 30 days
// the job is "in the buffer" (green). Past the buffer it's late: yellow
// through 15 days late, red after that.
//
// Reality clamp: while Substantial Completion isn't complete, its projected
// date can never be earlier than today — an overdue, un-updated schedule
// drifts one day later per day instead of holding a fictional finish date.

export const SCHEDULE_BUFFER_DAYS = 30
export const YELLOW_MAX_DAYS_LATE = 15

export type MilestoneItem = {
  milestone: "job_start" | "substantial_completion" | null
  start_date: string | null
  end_date: string | null
  baseline_start_date: string | null
  baseline_end_date: string | null
  status: string
}

export type ScheduleHealth =
  // Project predates the milestone backfill (or they were never created).
  | { state: "missing_milestones" }
  // Milestones exist but Job Start / Substantial Completion lack dates.
  | { state: "missing_dates" }
  // Dates are in but the baseline hasn't been locked yet.
  | { state: "no_baseline" }
  | {
      state: "tracked"
      tone: "green" | "yellow" | "red"
      label: string
      /** Duration growth vs baseline in days (negative = running shorter). */
      slipDays: number
      /** Days past the 30-day buffer (0 while inside it). */
      daysLate: number
      /** Buffer left (can exceed the buffer when running ahead of plan). */
      bufferRemainingDays: number
      baselineDurationDays: number
      currentDurationDays: number
      /** Substantial Completion end, clamped to today while incomplete. */
      projectedEndDate: string
      /** True when the clamp moved the projection past the stored date. */
      clamped: boolean
    }

const MS_PER_DAY = 86_400_000

// Bare YYYY-MM-DD strings parse as UTC midnight, so differences are exact
// day multiples. Inclusive count to match daysBetween in the schedule
// actions (duration of a same-day item is 1).
function durationDays(startISO: string, endISO: string): number {
  return Math.round((Date.parse(endISO) - Date.parse(startISO)) / MS_PER_DAY) + 1
}

export function computeScheduleHealth(
  items: MilestoneItem[],
  baselineSetAt: string | null,
  todayISO: string
): ScheduleHealth {
  const jobStart = items.find((i) => i.milestone === "job_start")
  const subComplete = items.find((i) => i.milestone === "substantial_completion")
  if (!jobStart || !subComplete) return { state: "missing_milestones" }
  if (!jobStart.start_date || !subComplete.end_date) {
    return { state: "missing_dates" }
  }
  if (
    !baselineSetAt ||
    !jobStart.baseline_start_date ||
    !subComplete.baseline_end_date
  ) {
    return { state: "no_baseline" }
  }

  const clamped =
    subComplete.status !== "complete" && subComplete.end_date < todayISO
  const projectedEndDate = clamped ? todayISO : subComplete.end_date

  const currentDurationDays = durationDays(jobStart.start_date, projectedEndDate)
  const baselineDurationDays = durationDays(
    jobStart.baseline_start_date,
    subComplete.baseline_end_date
  )
  const slipDays = currentDurationDays - baselineDurationDays
  const daysLate = Math.max(0, slipDays - SCHEDULE_BUFFER_DAYS)
  const bufferRemainingDays = SCHEDULE_BUFFER_DAYS - slipDays

  let tone: "green" | "yellow" | "red"
  let label: string
  if (daysLate === 0) {
    tone = "green"
    label = `${bufferRemainingDays} Day${bufferRemainingDays === 1 ? "" : "s"} Remaining in Buffer`
  } else {
    tone = daysLate <= YELLOW_MAX_DAYS_LATE ? "yellow" : "red"
    label = `${daysLate} Day${daysLate === 1 ? "" : "s"} Late`
  }

  return {
    state: "tracked",
    tone,
    label,
    slipDays,
    daysLate,
    bufferRemainingDays,
    baselineDurationDays,
    currentDurationDays,
    projectedEndDate,
    clamped,
  }
}
