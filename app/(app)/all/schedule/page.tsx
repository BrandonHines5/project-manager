import Link from "next/link"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"

export const metadata = { title: "Schedule (all jobs) — Hines Homes" }

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
  const scope = await resolveAllScope(params.ids)
  if (scope.projects.length === 0) return <EmptyScope explicit={scope.explicit} />

  const supabase = await createSupabaseServerClient()
  const projectIds = scope.projects.map((p) => p.id)

  // We can't order by COALESCE(start_date, due_date) via PostgREST cleanly,
  // and ordering by start_date first pushes all to-dos (start_date NULL)
  // to the end regardless of when they're due. Fetch and sort in-memory by
  // whichever date is meaningful for the row's kind. The scope can now span
  // every open job, so cap the fetch (deterministically, newest rows first —
  // the only orderable column both kinds share) instead of growing without
  // bound; the cap is generous enough that real portfolios stay under it.
  const ITEM_CAP = 2000
  const itemsRes = await supabase
    .from("schedule_items")
    .select(
      "id, project_id, kind, title, status, start_date, end_date, due_date"
    )
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(ITEM_CAP)
  if (itemsRes.error) throw new Error(itemsRes.error.message)
  const items = itemsRes.data
  const truncated = items.length === ITEM_CAP

  const projectMap = new Map(scope.projects.map((p) => [p.id, p] as const))
  const rows = [...items].sort((a, b) => {
    const aDate = a.kind === "work" ? a.start_date : a.due_date
    const bDate = b.kind === "work" ? b.start_date : b.due_date
    if (aDate == null && bDate == null) return 0
    if (aDate == null) return 1
    if (bDate == null) return -1
    return aDate.localeCompare(bDate)
  })
  const workCount = rows.filter((r) => r.kind === "work").length
  const todoCount = rows.length - workCount

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        {rows.length} item{rows.length === 1 ? "" : "s"} ({workCount} work,{" "}
        {todoCount} to-do) across {scopeLabel(scope)}
        {truncated &&
          ` (showing the ${ITEM_CAP} most recently added — select fewer jobs to see everything)`}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          No schedule items in these jobs.
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
