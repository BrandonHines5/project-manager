import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"
import { AllDecisionsTable, type DecisionTableRow } from "./all-decisions-table"

export const metadata = { title: "Decisions (all jobs) — BuildFox" }

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

  // Newest first with a cap, mirroring the daily-logs page — the scope can
  // now span every open job, so the fetch must not grow without bound.
  // The due-anchor embed names its FK: decisions↔schedule_items has two
  // relationships (due_anchor_schedule_item_id here, source_decision_id on
  // schedule_items), so a bare embed would be PGRST201-ambiguous.
  const decisionsRes = await supabase
    .from("decisions")
    .select(
      "id, project_id, number, kind, title, status, due_date, approved_at, created_at, due_anchor_schedule_item_id, due_anchor_item:schedule_items!decisions_due_anchor_schedule_item_id_fkey(title)"
    )
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(200)
  if (decisionsRes.error) throw new Error(decisionsRes.error.message)

  const projectMap = new Map(scope.projects.map((p) => [p.id, p] as const))
  const rows: DecisionTableRow[] = decisionsRes.data.map((d) => {
    const project = projectMap.get(d.project_id)
    return {
      id: d.id,
      project_id: d.project_id,
      number: d.number,
      kind: d.kind,
      title: d.title,
      status: d.status,
      due_date: d.due_date,
      due_anchor_schedule_item_id: d.due_anchor_schedule_item_id,
      due_anchor_title: d.due_anchor_item?.title ?? null,
      project: project
        ? { name: project.name, project_number: project.project_number }
        : null,
    }
  })

  return (
    <AllDecisionsTable
      rows={rows}
      scopeLabel={scopeLabel(scope)}
      truncated={decisionsRes.data.length === 200}
    />
  )
}
