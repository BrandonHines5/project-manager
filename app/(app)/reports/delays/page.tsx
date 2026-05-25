import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"

export const metadata = { title: "Delay Report — Hines Homes" }

const REASON_LABEL: Record<string, string> = {
  weather: "Weather",
  sub: "Subcontractor",
  material: "Material",
  owner_decision: "Owner decision",
  permit: "Permit",
  other: "Other",
}

export default async function DelayReportPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; from?: string; to?: string }>
}) {
  await requireStaff()
  const sp = await searchParams
  const supabase = await createSupabaseServerClient()

  let query = supabase
    .from("schedule_delays")
    .select(
      "*, schedule_items!inner(id, title, project_id, projects!inner(id, project_number, name))"
    )
    .order("logged_at", { ascending: false })

  if (sp.from) query = query.gte("logged_at", sp.from)
  if (sp.to) query = query.lte("logged_at", sp.to + "T23:59:59")
  if (sp.project) query = query.eq("schedule_items.project_id", sp.project)

  const { data: rows } = await query

  type Row = {
    id: string
    delay_days: number
    reason_category: string
    notes: string | null
    logged_at: string
    schedule_items: {
      id: string
      title: string
      project_id: string
      projects: { id: string; project_number: string; name: string }
    }
  }

  const rowsTyped = (rows ?? []) as unknown as Row[]

  // Aggregations
  const totalDays = rowsTyped.reduce((s, r) => s + (r.delay_days ?? 0), 0)
  const byCategory = new Map<string, { count: number; days: number }>()
  const byProject = new Map<
    string,
    { name: string; number: string; count: number; days: number }
  >()
  for (const r of rowsTyped) {
    const cat = r.reason_category as string
    const c = byCategory.get(cat) ?? { count: 0, days: 0 }
    c.count++
    c.days += r.delay_days ?? 0
    byCategory.set(cat, c)
    const p = byProject.get(r.schedule_items.project_id) ?? {
      name: r.schedule_items.projects.name,
      number: r.schedule_items.projects.project_number,
      count: 0,
      days: 0,
    }
    p.count++
    p.days += r.delay_days ?? 0
    byProject.set(r.schedule_items.project_id, p)
  }

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .order("project_number")

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-6">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mb-3"
      >
        <ArrowLeft className="h-3 w-3" /> All reports
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Delay Report</h1>
      <p className="text-sm text-muted mb-5">
        Logged delays from the schedule, grouped by reason and by project.
      </p>

      {/* Filters */}
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
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase text-muted">From</label>
          <input
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase text-muted">To</label>
          <input
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-sm"
          />
        </div>
        <button
          type="submit"
          className="h-9 px-4 rounded-md bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 cursor-pointer"
        >
          Apply
        </button>
        {(sp.project || sp.from || sp.to) && (
          <Link
            href="/reports/delays"
            className="h-9 inline-flex items-center text-sm text-muted hover:text-foreground"
          >
            Reset
          </Link>
        )}
      </form>

      {rowsTyped.length === 0 ? (
        <EmptyState
          title="No delays in this range"
          description="Logged delays will appear here."
        />
      ) : (
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Total entries" value={String(rowsTyped.length)} />
            <Stat label="Total delay days" value={String(totalDays)} />
            <Stat label="Projects affected" value={String(byProject.size)} />
            <Stat label="Reasons used" value={String(byCategory.size)} />
          </div>

          {/* By category */}
          <Card>
            <CardHeader>
              <CardTitle>By reason</CardTitle>
            </CardHeader>
            <table className="w-full text-sm">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">Reason</th>
                  <th className="text-right px-4 py-2.5 w-32">Entries</th>
                  <th className="text-right px-4 py-2.5 w-32">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Array.from(byCategory.entries())
                  .sort((a, b) => b[1].days - a[1].days)
                  .map(([cat, v]) => (
                    <tr key={cat}>
                      <td className="px-4 py-2">{REASON_LABEL[cat] ?? cat}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {v.count}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {v.days}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>

          {/* By project */}
          <Card>
            <CardHeader>
              <CardTitle>By project</CardTitle>
            </CardHeader>
            <table className="w-full text-sm">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">Project</th>
                  <th className="text-right px-4 py-2.5 w-32">Entries</th>
                  <th className="text-right px-4 py-2.5 w-32">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Array.from(byProject.entries())
                  .sort((a, b) => b[1].days - a[1].days)
                  .map(([pid, v]) => (
                    <tr key={pid}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/projects/${pid}/schedule`}
                          className="text-brand-600 hover:underline"
                        >
                          #{v.number} — {v.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {v.count}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {v.days}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>

          {/* Detailed list */}
          <Card>
            <CardHeader>
              <CardTitle>All entries</CardTitle>
            </CardHeader>
            <table className="w-full text-sm">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5 w-32">Logged</th>
                  <th className="text-left px-4 py-2.5">Project / item</th>
                  <th className="text-left px-4 py-2.5 w-36">Reason</th>
                  <th className="text-right px-4 py-2.5 w-20">Days</th>
                  <th className="text-left px-4 py-2.5">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rowsTyped.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 text-muted">
                      {formatDate(r.logged_at)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium text-sm">
                        <Link
                          href={`/projects/${r.schedule_items.project_id}/schedule`}
                          className="hover:underline"
                        >
                          {r.schedule_items.title}
                        </Link>
                      </div>
                      <div className="text-xs text-muted">
                        #{r.schedule_items.projects.project_number}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone="warning">
                        {REASON_LABEL[r.reason_category] ?? r.reason_category}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.delay_days}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {r.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs uppercase text-muted tracking-wide">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
      </CardBody>
    </Card>
  )
}
