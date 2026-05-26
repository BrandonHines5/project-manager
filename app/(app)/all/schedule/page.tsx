import Link from "next/link"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"
import { parseProjectIds } from "../parse-ids"
import { EmptySelection } from "../empty-selection"

export const metadata = { title: "Schedule (all) — Hines Homes" }

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

export default async function AggregateSchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSession()
  const params = await searchParams
  const ids = parseProjectIds(params.ids)
  if (ids.length === 0) return <EmptySelection entity="schedule items" />

  const supabase = await createSupabaseServerClient()

  // RLS still applies — projects the user can't see drop out automatically.
  // We sort by the earliest-relevant date per row so the resulting list reads
  // chronologically: work items use start_date, to-dos use due_date.
  const [{ data: projects }, { data: items }] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, project_number")
      .in("id", ids),
    supabase
      .from("schedule_items")
      .select(
        "id, project_id, kind, title, status, start_date, end_date, due_date"
      )
      .in("project_id", ids)
      .order("start_date", { ascending: true, nullsFirst: false })
      .order("due_date", { ascending: true, nullsFirst: false }),
  ])

  const projectMap = new Map(
    (projects ?? []).map((p) => [p.id, p] as const)
  )
  const rows = items ?? []
  const workCount = rows.filter((r) => r.kind === "work").length
  const todoCount = rows.length - workCount

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        {rows.length} item{rows.length === 1 ? "" : "s"} ({workCount} work,{" "}
        {todoCount} to-do) across {ids.length} project
        {ids.length === 1 ? "" : "s"}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          No schedule items in the selected projects.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
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
              {rows.map((r) => {
                const project = projectMap.get(r.project_id)
                const dateLabel =
                  r.kind === "work"
                    ? r.start_date && r.end_date
                      ? `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`
                      : "—"
                    : r.due_date
                      ? `Due ${formatDate(r.due_date)}`
                      : "—"
                return (
                  <tr key={r.id} className="hover:bg-background/60">
                    <td className="px-3 py-2 align-top">
                      {project ? (
                        <Link
                          href={`/projects/${r.project_id}/schedule`}
                          className="text-brand-600 hover:underline"
                        >
                          <div className="font-mono text-[11px]">
                            {project.project_number}
                          </div>
                          <div className="text-xs truncate max-w-[160px]">
                            {project.name}
                          </div>
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">{r.title}</td>
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
                    <td className="px-3 py-2 align-top hidden md:table-cell text-xs text-muted">
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
