import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import {
  DELAY_REASONS_KEY,
  parseDelayReasons,
  delayReasonLabel,
} from "@/lib/delays"

export const metadata = { title: "Delay Report — BuildFox" }

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

  // Configured (staff-editable) delay reasons, for labels.
  const { data: reasonSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", DELAY_REASONS_KEY)
    .maybeSingle()
  const delayReasons = parseDelayReasons(reasonSetting?.value ?? null)
  const reasonLabel = (value: string) => delayReasonLabel(value, delayReasons)

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

  // By assigned person / role. Each delay is attributed to every party assigned
  // to its schedule item (a delay with two assignees counts toward both), so
  // the days column can exceed the total. Delays on unassigned items land in an
  // "Unassigned" bucket. Names resolve from profiles / companies / roles.
  const byAssignee = new Map<
    string,
    { label: string; kind: string; count: number; days: number }
  >()
  if (rowsTyped.length > 0) {
    const itemIds = [...new Set(rowsTyped.map((r) => r.schedule_items.id))]
    const { data: assignRows, error: assignErr } = await supabase
      .from("schedule_assignments")
      .select("schedule_item_id, profile_id, company_id, role_id")
      .in("schedule_item_id", itemIds)
    if (assignErr) throw new Error(assignErr.message)

    const byItem = new Map<
      string,
      { profile_id: string | null; company_id: string | null; role_id: string | null }[]
    >()
    const profileIds = new Set<string>()
    const companyIds = new Set<string>()
    const roleIds = new Set<string>()
    for (const a of assignRows ?? []) {
      const list = byItem.get(a.schedule_item_id) ?? []
      list.push(a)
      byItem.set(a.schedule_item_id, list)
      if (a.profile_id) profileIds.add(a.profile_id)
      if (a.company_id) companyIds.add(a.company_id)
      if (a.role_id) roleIds.add(a.role_id)
    }

    // A valid-uuid sentinel that never matches — an empty .in() list is fine,
    // but a non-uuid placeholder ("-") would blow up the uuid cast.
    const NONE = "00000000-0000-0000-0000-000000000000"
    const [
      { data: aProfiles, error: profilesErr },
      { data: aCompanies, error: companiesErr },
      { data: aRoles, error: rolesErr },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", profileIds.size ? [...profileIds] : [NONE]),
      supabase
        .from("companies")
        .select("id, name")
        .in("id", companyIds.size ? [...companyIds] : [NONE]),
      supabase
        .from("roles")
        .select("id, name")
        .in("id", roleIds.size ? [...roleIds] : [NONE]),
    ])
    const lookupErr = profilesErr ?? companiesErr ?? rolesErr
    if (lookupErr) throw new Error(lookupErr.message)
    const profileName = new Map(
      (aProfiles ?? []).map((p) => [p.id, p.full_name || p.email || "Staff"])
    )
    const companyName = new Map((aCompanies ?? []).map((c) => [c.id, c.name]))
    const roleName = new Map((aRoles ?? []).map((r) => [r.id, r.name]))

    const bump = (key: string, label: string, kind: string, days: number) => {
      const v = byAssignee.get(key) ?? { label, kind, count: 0, days: 0 }
      v.count++
      v.days += days
      byAssignee.set(key, v)
    }
    for (const r of rowsTyped) {
      const days = r.delay_days ?? 0
      const assignees = byItem.get(r.schedule_items.id) ?? []
      if (assignees.length === 0) {
        bump("unassigned", "Unassigned", "unassigned", days)
        continue
      }
      for (const a of assignees) {
        if (a.profile_id) {
          bump(
            `p:${a.profile_id}`,
            profileName.get(a.profile_id) ?? "Staff",
            "Person",
            days
          )
        } else if (a.company_id) {
          bump(
            `c:${a.company_id}`,
            companyName.get(a.company_id) ?? "Company",
            "Sub / vendor",
            days
          )
        } else if (a.role_id) {
          bump(
            `r:${a.role_id}`,
            roleName.get(a.role_id) ?? "Role",
            "Role",
            days
          )
        }
      }
    }
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
                  <th className="text-right px-4 py-2.5 w-20 sm:w-32">Entries</th>
                  <th className="text-right px-4 py-2.5 w-20 sm:w-32">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Array.from(byCategory.entries())
                  .sort((a, b) => b[1].days - a[1].days)
                  .map(([cat, v]) => (
                    <tr key={cat}>
                      <td className="px-4 py-2">{reasonLabel(cat)}</td>
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

          {/* By assigned person / role */}
          <Card>
            <CardHeader>
              <CardTitle>By assigned person / role</CardTitle>
            </CardHeader>
            <p className="px-4 pt-1 pb-2 text-xs text-muted">
              Each delay counts toward every party assigned to its work item, so
              totals here can exceed the overall delay days.
            </p>
            <table className="w-full text-sm">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">Assigned to</th>
                  <th className="text-left px-4 py-2.5 w-24 sm:w-32">Type</th>
                  <th className="text-right px-4 py-2.5 w-16 sm:w-24">Entries</th>
                  <th className="text-right px-4 py-2.5 w-16 sm:w-24">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Array.from(byAssignee.entries())
                  .sort((a, b) => b[1].days - a[1].days)
                  .map(([key, v]) => (
                    <tr key={key}>
                      <td className="px-4 py-2">{v.label}</td>
                      <td className="px-4 py-2 text-muted">{v.kind}</td>
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
                  <th className="text-right px-4 py-2.5 w-20 sm:w-32">Entries</th>
                  <th className="text-right px-4 py-2.5 w-20 sm:w-32">Days</th>
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
            {/* Five columns incl. two text ones — scroll inside the card on
                phones instead of crushing them. */}
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
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
                        {reasonLabel(r.reason_category)}
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
            </div>
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
