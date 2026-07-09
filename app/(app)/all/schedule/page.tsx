import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { resolveAllScope, scopeLabel } from "../scope"
import { EmptyScope } from "../empty-scope"
import { AllScheduleTable, type ScheduleTableRow } from "./all-schedule-table"

export const metadata = { title: "Schedule (all jobs) — Hines Homes" }

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
  const rows: ScheduleTableRow[] = [...items]
    .sort((a, b) => {
      const aDate = a.kind === "work" ? a.start_date : a.due_date
      const bDate = b.kind === "work" ? b.start_date : b.due_date
      if (aDate == null && bDate == null) return 0
      if (aDate == null) return 1
      if (bDate == null) return -1
      return aDate.localeCompare(bDate)
    })
    .map((r) => {
      const project = projectMap.get(r.project_id)
      return {
        ...r,
        project: project
          ? { name: project.name, project_number: project.project_number }
          : null,
      }
    })

  return (
    <AllScheduleTable
      rows={rows}
      scopeLabel={scopeLabel(scope)}
      truncated={truncated}
      itemCap={ITEM_CAP}
    />
  )
}
