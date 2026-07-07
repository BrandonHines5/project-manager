"use client"

import { useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Flag, Lock, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn, formatDate, todayISO } from "@/lib/utils"
import { computeScheduleHealth } from "@/lib/schedule/health"
import {
  setScheduleBaseline,
  ensureProjectMilestones,
} from "@/app/actions/schedule"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"

/**
 * Schedule health strip at the top of the schedule page. Once the baseline is
 * locked it shows how the Job Start → Substantial Completion duration
 * compares to plan: green while inside the 30-day buffer, yellow up to 15
 * days late, red past that. Before that it walks staff through the setup
 * steps (milestone dates → lock baseline).
 */
export function ScheduleHealthBanner({ data }: { data: ScheduleData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const isStaff = data.role === "staff"

  const health = useMemo(
    () => computeScheduleHealth(data.items, data.baseline_set_at, todayISO()),
    [data.items, data.baseline_set_at]
  )
  const jobStart = data.items.find((i) => i.milestone === "job_start")
  const subComplete = data.items.find(
    (i) => i.milestone === "substantial_completion"
  )

  function lockBaseline(isRebaseline: boolean) {
    if (
      isRebaseline &&
      !confirm(
        "Re-lock the baseline to the CURRENT schedule? Slip tracking resets to zero against today's plan, and the old baseline is overwritten."
      )
    ) {
      return
    }
    startTransition(async () => {
      const res = await setScheduleBaseline({ project_id: data.project_id })
      if (res.ok) {
        toast.success(isRebaseline ? "Baseline re-locked" : "Baseline locked")
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  function createMilestones() {
    startTransition(async () => {
      try {
        const res = await ensureProjectMilestones({
          project_id: data.project_id,
        })
        toast.success(
          res.adopted > 0
            ? "Marked the existing Job Start / Substantial Completion items as milestones"
            : "Job Start and Substantial Completion added"
        )
        router.refresh()
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Could not set up milestones"
        )
      }
    })
  }

  if (health.state === "missing_milestones") {
    return (
      <Setup>
        <span>
          This project&apos;s <b>Job Start</b> / <b>Substantial Completion</b>{" "}
          milestones aren&apos;t set up yet — they define the tracked
          construction duration. If work items with those names already exist,
          they&apos;ll be used as-is.
        </span>
        {isStaff && (
          <Button size="sm" onClick={createMilestones} disabled={pending}>
            <Flag className="h-3.5 w-3.5" />
            {pending ? "Setting up…" : "Set up milestones"}
          </Button>
        )}
      </Setup>
    )
  }

  if (health.state === "missing_dates") {
    const missing = [
      !jobStart?.start_date ? "Job Start" : null,
      !subComplete?.end_date ? "Substantial Completion" : null,
    ]
      .filter(Boolean)
      .join(" and ")
    return (
      <Setup>
        <span>
          Set dates on <b>{missing}</b> (in the work item list) to start
          tracking the job duration.
        </span>
      </Setup>
    )
  }

  if (health.state === "no_baseline") {
    return (
      <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-foreground">
          <span className="font-semibold">Baseline not locked.</span>{" "}
          <span className="text-muted">
            Lock the plan to start slip tracking — until then, work items
            can&apos;t be marked complete and date moves aren&apos;t tracked.
          </span>
        </div>
        {isStaff && (
          <Button size="sm" onClick={() => lockBaseline(false)} disabled={pending}>
            <Lock className="h-3.5 w-3.5" />
            {pending ? "Locking…" : "Set baseline"}
          </Button>
        )}
      </div>
    )
  }

  const tone = health.tone
  const toneClasses = {
    green: "border-success/40 bg-success/10",
    yellow: "border-warning/50 bg-warning/10",
    red: "border-danger/50 bg-danger/10",
  }[tone]
  const chipClasses = {
    green: "bg-success text-white",
    yellow: "bg-warning text-white",
    red: "bg-danger text-white",
  }[tone]

  return (
    <div
      className={cn(
        "mb-4 rounded-lg border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2",
        toneClasses
      )}
    >
      <span
        className={cn(
          "inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap",
          chipClasses
        )}
      >
        {health.label}
      </span>
      <div className="text-sm text-foreground min-w-0">
        <span className="font-medium">
          Job Start {formatDate(jobStart?.start_date)} → Substantial Completion{" "}
          {formatDate(health.projectedEndDate)}
        </span>
        <span className="text-muted">
          {" · "}
          {health.currentDurationDays} days vs {health.baselineDurationDays}
          -day baseline
          {health.slipDays !== 0 &&
            ` (${health.slipDays > 0 ? "+" : ""}${health.slipDays}d)`}
          {health.clamped &&
            " · past its scheduled finish — update Substantial Completion"}
        </span>
      </div>
      {isStaff && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => lockBaseline(true)}
          disabled={pending}
          className="ml-auto text-muted hover:text-foreground"
          title="Overwrite the baseline with the current schedule"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Re-baseline
        </Button>
      )}
    </div>
  )
}

function Setup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      {children}
    </div>
  )
}
