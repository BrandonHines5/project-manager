import Link from "next/link"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import { parseProjectIds } from "../parse-ids"
import { EmptySelection } from "../empty-selection"

export const metadata = { title: "Daily Logs (all) — Hines Homes" }

export default async function AggregateDailyLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireSession()
  const params = await searchParams
  const ids = parseProjectIds(params.ids)
  if (ids.length === 0) return <EmptySelection entity="daily logs" />

  const supabase = await createSupabaseServerClient()
  // RLS handles per-row visibility: clients only see logs where
  // visibility='client' AND they're a project member. Staff see everything.
  const [projectsRes, logsRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, project_number")
      .in("id", ids),
    supabase
      .from("daily_logs")
      .select("id, project_id, log_date, notes, visibility, created_at")
      .in("project_id", ids)
      .order("log_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
  ])
  if (projectsRes.error) throw new Error(projectsRes.error.message)
  if (logsRes.error) throw new Error(logsRes.error.message)

  const projectMap = new Map(projectsRes.data.map((p) => [p.id, p] as const))
  const rows = logsRes.data

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        {rows.length} log{rows.length === 1 ? "" : "s"} across {ids.length} project
        {ids.length === 1 ? "" : "s"}
        {rows.length === 200 && " (showing latest 200)"}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          No daily logs in the selected projects.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((log) => {
            const project = projectMap.get(log.project_id)
            const showVisibility =
              profile.role === "staff" && log.visibility === "internal"
            return (
              <li
                key={log.id}
                className="bg-surface border border-border rounded-lg p-4"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {project && (
                      <Link
                        href={`/projects/${log.project_id}/daily-logs`}
                        className="text-xs font-mono text-brand-600 hover:underline shrink-0"
                      >
                        {project.project_number}
                      </Link>
                    )}
                    <span className="text-sm font-medium truncate">
                      {project?.name ?? "—"}
                    </span>
                    {showVisibility && (
                      <Badge tone="muted">Internal</Badge>
                    )}
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
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
