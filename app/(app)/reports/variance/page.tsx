import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatDate, cn } from "@/lib/utils"

export const metadata = { title: "Schedule Variance — Hines Homes" }

export default async function VarianceReportPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>
}) {
  await requireStaff()
  const sp = await searchParams
  const supabase = await createSupabaseServerClient()

  let q = supabase
    .from("schedule_items")
    .select(
      "id, title, start_date, end_date, baseline_start_date, baseline_end_date, status, project_id, projects!inner(id, project_number, name)"
    )
    .eq("kind", "work")
    .not("baseline_start_date", "is", null)
    .not("baseline_end_date", "is", null)
    .order("start_date", { ascending: true })

  if (sp.project) q = q.eq("project_id", sp.project)

  const { data: rows } = await q
  type Row = {
    id: string
    title: string
    start_date: string | null
    end_date: string | null
    baseline_start_date: string | null
    baseline_end_date: string | null
    status: string
    project_id: string
    projects: { id: string; project_number: string; name: string }
  }
  const rowsTyped = (rows ?? []) as unknown as Row[]

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .order("project_number")

  function diffDays(a: string | null, b: string | null) {
    if (!a || !b) return 0
    return Math.round(
      (new Date(b).getTime() - new Date(a).getTime()) / 86400000
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-6">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mb-3"
      >
        <ArrowLeft className="h-3 w-3" /> All reports
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight mb-1">
        Schedule Variance
      </h1>
      <p className="text-sm text-muted mb-5">
        Baseline (planned) vs. current dates per work item. Positive variance =
        late.
      </p>

      <form className="flex flex-wrap items-end gap-3 mb-6 bg-surface border border-border rounded-lg p-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase text-muted">Project</label>
          <select
            name="project"
            defaultValue={sp.project ?? ""}
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-sm"
          >
            <option value="">All projects</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                #{p.project_number} — {p.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="h-9 px-4 rounded-md bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 cursor-pointer"
        >
          Apply
        </button>
        {sp.project && (
          <Link
            href="/reports/variance"
            className="h-9 inline-flex items-center text-sm text-muted hover:text-foreground"
          >
            Reset
          </Link>
        )}
      </form>

      {rowsTyped.length === 0 ? (
        <EmptyState
          title="No baseline dates set"
          description="Variance is computed when an item has both baseline_start_date and baseline_end_date populated. Set baselines when the schedule is locked in."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {rowsTyped.length} work item{rowsTyped.length === 1 ? "" : "s"} with
              baseline
            </CardTitle>
          </CardHeader>
          {/* Six date columns can't fit a phone; scroll the table inside the
              card instead of crushing every cell into multi-line soup. */}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-4 py-2.5">Project / item</th>
                <th className="text-left px-4 py-2.5 w-32">Baseline start</th>
                <th className="text-left px-4 py-2.5 w-32">Current start</th>
                <th className="text-left px-4 py-2.5 w-32">Baseline end</th>
                <th className="text-left px-4 py-2.5 w-32">Current end</th>
                <th className="text-right px-4 py-2.5 w-28">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rowsTyped.map((r) => {
                const startVar = diffDays(
                  r.baseline_start_date,
                  r.start_date
                )
                const endVar = diffDays(r.baseline_end_date, r.end_date)
                const worst = Math.max(Math.abs(startVar), Math.abs(endVar))
                const sign = endVar !== 0 ? endVar : startVar
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-sm">
                        <Link
                          href={`/projects/${r.project_id}/schedule`}
                          className="hover:underline"
                        >
                          {r.title}
                        </Link>
                      </div>
                      <div className="text-xs text-muted">
                        #{r.projects.project_number}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {formatDate(r.baseline_start_date)}
                    </td>
                    <td className="px-4 py-2">{formatDate(r.start_date)}</td>
                    <td className="px-4 py-2 text-muted">
                      {formatDate(r.baseline_end_date)}
                    </td>
                    <td className="px-4 py-2">{formatDate(r.end_date)}</td>
                    <td
                      className={cn(
                        "px-4 py-2 text-right tabular-nums font-medium",
                        worst === 0 && "text-muted",
                        sign > 0 && worst > 0 && "text-danger",
                        sign < 0 && worst > 0 && "text-success"
                      )}
                    >
                      {sign > 0 ? "+" : ""}
                      {sign}d
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  )
}
