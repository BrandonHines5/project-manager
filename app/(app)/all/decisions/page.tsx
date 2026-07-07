import Link from "next/link"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"

export const metadata = { title: "Decisions (all jobs) — Hines Homes" }

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

export default async function AggregateDecisionsPage({
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

  const decisionsRes = await supabase
    .from("decisions")
    .select(
      "id, project_id, number, kind, title, status, due_date, approved_at, created_at"
    )
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
  if (decisionsRes.error) throw new Error(decisionsRes.error.message)

  const projectMap = new Map(scope.projects.map((p) => [p.id, p] as const))
  const rows = decisionsRes.data

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        {rows.length} decision{rows.length === 1 ? "" : "s"} across{" "}
        {scopeLabel(scope)}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          No decisions in these jobs.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
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
              {rows.map((d) => {
                const project = projectMap.get(d.project_id)
                return (
                  <tr key={d.id} className="hover:bg-background/60">
                    <td className="px-3 py-2 align-top">
                      {project ? (
                        <Link
                          href={`/projects/${d.project_id}/decisions`}
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
