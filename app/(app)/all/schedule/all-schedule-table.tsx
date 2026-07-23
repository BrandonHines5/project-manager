"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn, formatDate, todayISO } from "@/lib/utils"
import { isLateScheduleItem } from "@/lib/schedule/late"
import type { Enums } from "@/lib/db/types"

const STATUS_TONE: Record<
  Enums<"schedule_item_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  not_started: "muted",
  in_progress: "info",
  complete: "success",
  delayed: "danger",
}

const STATUS_LABEL: Record<Enums<"schedule_item_status">, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  delayed: "Delayed",
}

export type ScheduleTableRow = {
  id: string
  project_id: string
  kind: Enums<"schedule_item_kind">
  title: string
  status: Enums<"schedule_item_status">
  start_date: string | null
  end_date: string | null
  due_date: string | null
  project: { name: string; project_number: string } | null
}

export function AllScheduleTable({
  rows,
  scopeLabel,
  truncated,
  itemCap,
}: {
  rows: ScheduleTableRow[]
  scopeLabel: string
  truncated: boolean
  itemCap: number
}) {
  const [query, setQuery] = useState("")
  // One "today" per render so every row's late check agrees.
  const today = todayISO()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const kindLabel = r.kind === "work" ? "work" : "to-do"
      return (
        r.title.toLowerCase().includes(q) ||
        (r.project?.name.toLowerCase().includes(q) ?? false) ||
        (r.project?.project_number.toLowerCase().includes(q) ?? false) ||
        STATUS_LABEL[r.status].toLowerCase().includes(q) ||
        kindLabel.includes(q)
      )
    })
  }, [rows, query])

  const workCount = filtered.filter((r) => r.kind === "work").length
  const todoCount = filtered.length - workCount
  const active = query.trim().length > 0

  return (
    <div>
      <div className="mb-3 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items, jobs, or status…"
          aria-label="Search schedule items"
          className="w-full h-10 pl-9 pr-3 text-sm rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        />
      </div>

      <div className="mb-4 text-sm text-muted">
        {active
          ? `${filtered.length} of ${rows.length} item${
              rows.length === 1 ? "" : "s"
            } match`
          : `${filtered.length} item${filtered.length === 1 ? "" : "s"}`}{" "}
        ({workCount} work, {todoCount} to-do) across {scopeLabel}
        {truncated &&
          !active &&
          ` (showing the ${itemCap} most recently added — select fewer jobs to see everything)`}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          {active
            ? "No schedule items match your search."
            : "No schedule items in these jobs."}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs text-muted uppercase">
              <tr>
                <th className="text-left font-medium px-3 py-2">Project</th>
                <th className="text-left font-medium px-3 py-2">Item</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">
                  Kind
                </th>
                <th className="text-left font-medium px-3 py-2">Status</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">
                  Dates
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => {
                const dateLabel =
                  r.kind === "work"
                    ? r.start_date && r.end_date
                      ? `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`
                      : "—"
                    : r.due_date
                      ? `Due ${formatDate(r.due_date)}`
                      : "—"
                const isLate = isLateScheduleItem(r, today)
                return (
                  <tr key={r.id} className="hover:bg-background/60">
                    <td className="px-3 py-2 align-top">
                      {r.project ? (
                        <Link
                          href={`/projects/${r.project_id}/schedule`}
                          className="text-brand-600 hover:underline"
                        >
                          <div className="font-mono text-[11px]">
                            {r.project.project_number}
                          </div>
                          <div className="text-xs truncate max-w-[160px]">
                            {r.project.name}
                          </div>
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 align-top",
                        isLate && "text-danger"
                      )}
                    >
                      {r.title}
                    </td>
                    <td className="px-3 py-2 align-top hidden md:table-cell">
                      <span className="text-xs text-muted capitalize">
                        {r.kind === "work" ? "Work" : "To-do"}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge tone={STATUS_TONE[r.status]}>
                        {STATUS_LABEL[r.status]}
                      </Badge>
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 align-top hidden md:table-cell text-xs",
                        isLate ? "text-danger" : "text-muted"
                      )}
                    >
                      {dateLabel}
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
