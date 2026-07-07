"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search, Activity, AlertTriangle, Tag } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn, formatCurrency, formatDate } from "@/lib/utils"
import { crmStatusTone } from "@/lib/crm-status"
import {
  ALL_STATUSES,
  STATUS_FILTER_LABEL,
  isProjectStatusFilter,
  matchesStatusFilter,
  type ProjectStatusFilter,
} from "@/lib/project-status"
import type { Enums } from "@/lib/db/types"

// Shares the filter vocabulary with the desktop project sidebar
// (components/layout/project-list-sidebar.tsx) via lib/project-status.ts, so
// the two filters read the same way: All, the Open group, then each CRM status
// by its exact word. Filtering runs off the `status` enum, not the verbatim
// CRM word, so the chips stay stable even when a job's crm_status is an
// unmapped label.
const STATUS_FILTERS: ReadonlyArray<ProjectStatusFilter> = [
  "all",
  "open",
  ...ALL_STATUSES,
]

// The active filter is either a ProjectStatusFilter value or a label filter
// encoded as "label:<name>", so a single piece of state can drive both the
// status chips and the tag chips. Same encoding the desktop sidebar uses.
const LABEL_PREFIX = "label:"

// The enum mirrors the CRM's statuses, so labels are the CRM's exact words
// (and tones match crmStatusTone so synced and un-synced jobs look alike).
const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  upcoming: "info",
  in_work: "brand",
  inventory: "info",
  paused: "warning",
  complete: "success",
  warranty: "info",
  cancelled: "danger",
}

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  upcoming: "Upcoming",
  in_work: "In Work",
  inventory: "Inventory",
  paused: "Paused",
  complete: "Complete",
  warranty: "Warranty",
  cancelled: "Cancelled",
}

export type ProjectMetrics = {
  total: number
  complete: number
  delayed: number
  inProgress: number
  pastDue: number
}

export type ProjectRow = {
  id: string
  project_number: string
  name: string
  address: string | null
  status: Enums<"project_status">
  crm_status: string | null
  contract_price: number | null
  target_completion_date: string | null
  is_template: boolean
  labels: string[]
  metrics: ProjectMetrics
  delta: number
}

export function ProjectsTable({
  rows,
  financialAccess,
}: {
  rows: ProjectRow[]
  financialAccess: boolean
}) {
  const [query, setQuery] = useState("")
  // Either a ProjectStatusFilter or a "label:<name>" string.
  const [filter, setFilter] = useState<string>("all")

  // Count per status filter so each chip can show how many jobs it holds —
  // the search box narrows the visible rows but not these headline counts.
  const counts = useMemo(() => {
    const c = {} as Record<ProjectStatusFilter, number>
    for (const f of STATUS_FILTERS) c[f] = 0
    for (const r of rows) {
      for (const f of STATUS_FILTERS) {
        if (matchesStatusFilter(r.status, f)) c[f] += 1
      }
    }
    return c
  }, [rows])

  // Distinct labels in use across all projects, with a per-label job count, so
  // every label that exists on a project becomes its own filter chip.
  const labelChips = useMemo(() => {
    const byLabel = new Map<string, number>()
    for (const r of rows) {
      for (const l of r.labels ?? []) {
        byLabel.set(l, (byLabel.get(l) ?? 0) + 1)
      }
    }
    return Array.from(byLabel.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [rows])

  const activeLabel = filter.startsWith(LABEL_PREFIX)
    ? filter.slice(LABEL_PREFIX.length)
    : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (activeLabel) {
        if (!(r.labels ?? []).includes(activeLabel)) return false
      } else if (
        isProjectStatusFilter(filter) &&
        !matchesStatusFilter(r.status, filter)
      ) {
        return false
      }
      if (!q) return true
      return (
        r.name.toLowerCase().includes(q) ||
        r.project_number.toLowerCase().includes(q) ||
        (r.address?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [rows, query, filter, activeLabel])

  return (
    <div>
      {/* Filter bar — visible on every breakpoint, laid out for a phone first.
          Search stacks above a horizontally-scrollable row of status chips. */}
      <div className="mb-3 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="w-full h-10 pl-9 pr-3 text-sm rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                filter === s
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-border bg-surface text-muted hover:text-foreground hover:bg-background"
              )}
            >
              {STATUS_FILTER_LABEL[s]}
              <span
                className={cn(
                  "tabular-nums text-xs",
                  filter === s ? "text-brand-600" : "text-muted"
                )}
              >
                {counts[s]}
              </span>
            </button>
          ))}
          {labelChips.length > 0 && (
            <span
              aria-hidden
              className="shrink-0 self-stretch w-px bg-border mx-0.5"
            />
          )}
          {labelChips.map(({ name, count }) => {
            const key = `${LABEL_PREFIX}${name}`
            const isActive = filter === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-border bg-surface text-muted hover:text-foreground hover:bg-background"
                )}
              >
                <Tag className="h-3 w-3" />
                {name}
                <span
                  className={cn(
                    "tabular-nums text-xs",
                    isActive ? "text-brand-600" : "text-muted"
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg px-4 py-10 text-center text-sm text-muted">
          No projects match your filters.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs text-muted uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Project #</th>
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">
                  Address
                </th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-left font-medium px-4 py-2.5 hidden xl:table-cell">
                  Progress
                </th>
                <th className="text-left font-medium px-4 py-2.5 hidden xl:table-cell">
                  Schedule
                </th>
                {financialAccess && (
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Contract
                  </th>
                )}
                {financialAccess && (
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Changes
                  </th>
                )}
                <th className="text-left font-medium px-4 py-2.5 hidden lg:table-cell">
                  Target
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((p) => {
                const m = p.metrics
                const pct =
                  m.total > 0 ? Math.round((m.complete / m.total) * 100) : 0
                const delta = p.delta
                return (
                  <tr
                    key={p.id}
                    className="hover:bg-background/60 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        href={`/projects/${p.id}/schedule`}
                        className="text-brand-600 hover:underline"
                      >
                        {p.project_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/projects/${p.id}/schedule`}
                        className="hover:underline"
                      >
                        {p.name}
                      </Link>
                      {p.is_template && (
                        <Badge tone="warning" className="ml-2 align-middle">
                          Template
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted hidden md:table-cell truncate max-w-xs">
                      {p.address || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {p.crm_status ? (
                        <Badge tone={crmStatusTone(p.crm_status)}>
                          {p.crm_status}
                        </Badge>
                      ) : (
                        <Badge tone={STATUS_TONE[p.status]}>
                          {STATUS_LABEL[p.status]}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell">
                      {m.total > 0 ? (
                        <ProgressBar pct={pct} />
                      ) : (
                        <span className="text-muted text-xs">no items</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell text-xs">
                      <ScheduleHealth metrics={m} status={p.status} />
                    </td>
                    {financialAccess && (
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                        {formatCurrency(p.contract_price)}
                      </td>
                    )}
                    {financialAccess && (
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                        {delta === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span
                            className={cn(
                              delta > 0 ? "text-amber-900" : "text-success"
                            )}
                          >
                            {(delta > 0 ? "+" : "") + formatCurrency(delta)}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-muted hidden lg:table-cell">
                      {formatDate(p.target_completion_date)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2 w-32">
      <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full",
            clamped >= 100
              ? "bg-success"
              : clamped >= 60
                ? "bg-brand-500"
                : "bg-amber-500"
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-muted tabular-nums">{clamped}%</span>
    </div>
  )
}

function ScheduleHealth({
  metrics,
  status,
}: {
  metrics: ProjectMetrics
  status: Enums<"project_status">
}) {
  if (metrics.total === 0) return <span className="text-muted">—</span>
  if (status === "complete" || status === "cancelled") {
    return <span className="text-muted">closed</span>
  }
  // Order matters: a past-due item is louder than a same-day "in progress",
  // and "delayed" status outranks both. Pick the loudest signal so the row
  // gives a one-glance health read without the PM scanning numbers.
  if (metrics.delayed > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-danger">
        <AlertTriangle className="h-3 w-3" />
        {metrics.delayed} delayed
      </span>
    )
  }
  if (metrics.pastDue > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-900">
        <AlertTriangle className="h-3 w-3" />
        {metrics.pastDue} past due
      </span>
    )
  }
  if (metrics.inProgress > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-brand-700">
        <Activity className="h-3 w-3" />
        {metrics.inProgress} in progress
      </span>
    )
  }
  return <span className="text-muted">on track</span>
}
