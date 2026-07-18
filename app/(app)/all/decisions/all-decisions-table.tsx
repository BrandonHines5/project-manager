"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { CalendarClock, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

const STATUS_TONE: Record<
  Enums<"decision_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  draft: "muted",
  pending_client: "warning",
  approved: "success",
  rejected: "danger",
}

const STATUS_LABEL: Record<Enums<"decision_status">, string> = {
  draft: "Draft",
  pending_client: "Pending client",
  approved: "Approved",
  rejected: "Rejected",
}

export type DecisionTableRow = {
  id: string
  project_id: string
  number: number
  kind: Enums<"decision_kind">
  title: string
  status: Enums<"decision_status">
  due_date: string | null
  due_anchor_schedule_item_id: string | null
  due_anchor_title: string | null
  project: { name: string; project_number: string } | null
}

export function AllDecisionsTable({
  rows,
  scopeLabel,
  truncated,
}: {
  rows: DecisionTableRow[]
  scopeLabel: string
  truncated: boolean
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((d) => {
      const kindLabel =
        d.kind === "change_order" ? "change order" : "selection"
      return (
        d.title.toLowerCase().includes(q) ||
        String(d.number).includes(q) ||
        (d.project?.name.toLowerCase().includes(q) ?? false) ||
        (d.project?.project_number.toLowerCase().includes(q) ?? false) ||
        STATUS_LABEL[d.status].toLowerCase().includes(q) ||
        kindLabel.includes(q)
      )
    })
  }, [rows, query])

  const active = query.trim().length > 0

  return (
    <div>
      <div className="mb-3 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search decisions, jobs, or status…"
          aria-label="Search decisions"
          className="w-full h-10 pl-9 pr-3 text-sm rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        />
      </div>

      <div className="mb-4 text-sm text-muted">
        {active
          ? `${filtered.length} of ${rows.length} decision${
              rows.length === 1 ? "" : "s"
            } match`
          : `${filtered.length} decision${
              filtered.length === 1 ? "" : "s"
            }`}{" "}
        across {scopeLabel}
        {truncated && !active && " (showing latest 200)"}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          {active
            ? "No decisions match your search."
            : "No decisions in these jobs."}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs text-muted uppercase">
              <tr>
                <th className="text-left font-medium px-3 py-2">Project</th>
                <th className="text-left font-medium px-3 py-2">#</th>
                <th className="text-left font-medium px-3 py-2">Title</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">
                  Kind
                </th>
                <th className="text-left font-medium px-3 py-2">Status</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">
                  Due
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((d) => (
                <tr key={d.id} className="hover:bg-background/60">
                  <td className="px-3 py-2 align-top">
                    {d.project ? (
                      <Link
                        href={`/projects/${d.project_id}/decisions`}
                        className="text-brand-600 hover:underline"
                      >
                        <div className="font-mono text-[11px]">
                          {d.project.project_number}
                        </div>
                        <div className="text-xs truncate max-w-[160px]">
                          {d.project.name}
                        </div>
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs">
                    {d.number}
                  </td>
                  <td className="px-3 py-2 align-top">{d.title}</td>
                  <td className="px-3 py-2 align-top hidden md:table-cell text-xs text-muted capitalize">
                    {d.kind === "change_order" ? "Change order" : "Selection"}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Badge tone={STATUS_TONE[d.status]}>
                      {STATUS_LABEL[d.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 align-top hidden md:table-cell text-xs text-muted">
                    {d.due_date ? formatDate(d.due_date) : "—"}
                    {d.due_anchor_schedule_item_id && (
                      <span
                        title={`Follows ${d.due_anchor_title ?? "the schedule"}`}
                      >
                        <CalendarClock className="inline h-3 w-3 ml-1 text-brand-500 align-[-2px]" />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
