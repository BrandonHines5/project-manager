import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"
import { AllDailyLogsList, type DailyLogRow } from "./all-daily-logs-list"
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
  const logs = logsRes.data

  // Comments for the logs on screen. The same staff↔client thread the
  // per-project Job Logs page shows — RLS scopes which rows come back, so a
  // client only ever sees comments on client-visible logs of their projects.
  const logIds = logs.map((l) => l.id)
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
  const placeholder =
    profile.role === "client"
      ? "Question or note for the builder…"
      : "Reply to client / leave a note"

  const rows: DailyLogRow[] = logs.map((log) => {
    const project = projectMap.get(log.project_id)
    return {
      id: log.id,
      project_id: log.project_id,
      log_date: log.log_date,
      notes: log.notes,
      showVisibility:
        profile.role === "staff" && log.visibility === "internal",
      canPost: profile.role === "staff" || log.visibility === "client",
      comments: (commentsByLog.get(log.id) ?? []).map((c) => ({
        id: c.id,
        author_name: c.author_name,
        author_role: null,
        body: c.body,
        created_at: c.created_at,
      })),
      project: project
        ? { name: project.name, project_number: project.project_number }
        : null,
    }
  })

  return (
    <AllDailyLogsList
      rows={rows}
      scopeLabel={scopeLabel(scope)}
      truncated={logs.length === 200}
      meName={meName}
      placeholder={placeholder}
    />
  )
}
