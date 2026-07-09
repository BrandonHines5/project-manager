"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import { LogCommentsToggle } from "@/components/daily-logs/log-comments-toggle"

type LogComment = {
  id: string
  author_name: string
  author_role: null
  body: string
  created_at: string
}

export type DailyLogRow = {
  id: string
  project_id: string
  log_date: string
  notes: string | null
  showVisibility: boolean
  canPost: boolean
  comments: LogComment[]
  project: { name: string; project_number: string } | null
}

export function AllDailyLogsList({
  rows,
  scopeLabel,
  truncated,
  meName,
  placeholder,
}: {
  rows: DailyLogRow[]
  scopeLabel: string
  truncated: boolean
  meName: string
  placeholder: string
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (log) =>
        (log.notes?.toLowerCase().includes(q) ?? false) ||
        (log.project?.name.toLowerCase().includes(q) ?? false) ||
        (log.project?.project_number.toLowerCase().includes(q) ?? false)
    )
  }, [rows, query])

  const active = query.trim().length > 0

  return (
    <div>
      <div className="mb-3 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search logs or jobs…"
          aria-label="Search job logs"
          className="w-full h-10 pl-9 pr-3 text-sm rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        />
      </div>

      <div className="mb-4 text-sm text-muted">
        {active
          ? `${filtered.length} of ${rows.length} log${
              rows.length === 1 ? "" : "s"
            } match`
          : `${filtered.length} log${filtered.length === 1 ? "" : "s"}`}{" "}
        across {scopeLabel}
        {truncated && !active && " (showing latest 200)"}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          {active
            ? "No job logs match your search."
            : "No job logs in these jobs."}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((log) => (
            <li
              key={log.id}
              className="bg-surface border border-border rounded-lg p-4"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {log.project && (
                    <Link
                      href={`/projects/${log.project_id}/daily-logs`}
                      className="text-xs font-mono text-brand-600 hover:underline shrink-0"
                    >
                      {log.project.project_number}
                    </Link>
                  )}
                  <span className="text-sm font-medium truncate">
                    {log.project?.name ?? "—"}
                  </span>
                  {log.showVisibility && <Badge tone="muted">Internal</Badge>}
                </div>
                <div className="text-xs text-muted shrink-0">
                  {formatDate(log.log_date)}
                </div>
              </div>
              {log.notes && (
                <p className="text-sm whitespace-pre-wrap line-clamp-4">
                  {log.notes}
                </p>
              )}
              <LogCommentsToggle
                dailyLogId={log.id}
                projectId={log.project_id}
                comments={log.comments}
                meName={meName}
                canPost={log.canPost}
                placeholder={placeholder}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
