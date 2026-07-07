import Link from "next/link"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"
import { LogCommentsToggle } from "@/components/daily-logs/log-comments-toggle"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Job Logs (all jobs) — Hines Homes" }

export default async function AggregateDailyLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireSession()
  const params = await searchParams
  const scope = await resolveAllScope(params.ids)
  if (scope.projects.length === 0) return <EmptyScope explicit={scope.explicit} />

  const supabase = await createSupabaseServerClient()
  const projectIds = scope.projects.map((p) => p.id)

  // RLS handles per-row visibility: clients only see logs where
  // visibility='client' AND they're a project member. Staff see everything.
  const logsRes = await supabase
    .from("daily_logs")
    .select("id, project_id, log_date, notes, visibility, created_at")
    .in("project_id", projectIds)
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200)
  if (logsRes.error) throw new Error(logsRes.error.message)

  const projectMap = new Map(scope.projects.map((p) => [p.id, p] as const))
  const rows = logsRes.data

  // Comments for the logs on screen. The same staff↔client thread the
  // per-project Job Logs page shows — RLS scopes which rows come back, so a
  // client only ever sees comments on client-visible logs of their projects.
  const logIds = rows.map((l) => l.id)
  const commentsByLog = new Map<string, Tables<"daily_log_comments">[]>()
  if (logIds.length) {
    const { data: commentRows } = await supabase
      .from("daily_log_comments")
      .select("*")
      .in("daily_log_id", logIds)
      .order("created_at", { ascending: true })
    for (const c of commentRows ?? []) {
      const list = commentsByLog.get(c.daily_log_id) ?? []
      list.push(c)
      commentsByLog.set(c.daily_log_id, list)
    }
  }
  const meName = profile.full_name ?? profile.email ?? "Me"

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        {rows.length} log{rows.length === 1 ? "" : "s"} across{" "}
        {scopeLabel(scope)}
        {rows.length === 200 && " (showing latest 200)"}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          No job logs in these jobs.
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
                <LogCommentsToggle
                  dailyLogId={log.id}
                  projectId={log.project_id}
                  comments={(commentsByLog.get(log.id) ?? []).map((c) => ({
                    id: c.id,
                    author_name: c.author_name,
                    author_role: null,
                    body: c.body,
                    created_at: c.created_at,
                  }))}
                  meName={meName}
                  canPost={
                    profile.role === "staff" || log.visibility === "client"
                  }
                  placeholder={
                    profile.role === "client"
                      ? "Question or note for the builder…"
                      : "Reply to client / leave a note"
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
