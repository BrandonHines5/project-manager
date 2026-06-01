import Link from "next/link"
import {
  Plus,
  FolderKanban,
  Activity,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
} from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Card, CardBody } from "@/components/ui/card"
import { FeedbackNotification } from "@/components/feedback/feedback-notification"
import { MyFeedbackNotification } from "@/components/feedback/my-feedback-notification"
import { cn, formatCurrency, formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Projects — Hines Homes" }

const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  lead: "muted",
  pre_construction: "info",
  active: "brand",
  on_hold: "warning",
  complete: "success",
  cancelled: "danger",
}

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  lead: "Lead",
  pre_construction: "Pre-construction",
  active: "Active",
  on_hold: "On hold",
  complete: "Complete",
  cancelled: "Cancelled",
}

// A project counts as "active for portfolio health" when it's in one of these
// statuses. Leads / on-hold / complete / cancelled are excluded from the
// on-time / delayed roll-up because they aren't a live build the PM team is
// pushing against today.
const PORTFOLIO_ACTIVE: Enums<"project_status">[] = [
  "pre_construction",
  "active",
]

export default async function ProjectsPage() {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data: projects } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, address, status, contract_price, start_date, target_completion_date, dashboard_url"
    )
    .order("created_at", { ascending: false })

  // Pull schedule + decisions across every visible project in a single
  // pair of queries. Even with 30 active jobs × 200 items, this is well
  // under the connection round-trip budget for an SSR page and keeps the
  // dashboard responsive.
  const projectIds = (projects ?? []).map((p) => p.id)
  const [{ data: items }, { data: approvedDecisions }] =
    projectIds.length === 0
      ? [{ data: [] as ScheduleSlim[] }, { data: [] as DecisionSlim[] }]
      : await Promise.all([
          supabase
            .from("schedule_items")
            .select("project_id, kind, status, end_date, due_date")
            .in("project_id", projectIds),
          supabase
            .from("decisions")
            .select("project_id, cost_delta")
            .in("project_id", projectIds)
            .eq("status", "approved"),
        ])

  // Roll up per-project metrics in one pass over the schedule rows.
  const metricsByProject = new Map<string, ProjectMetrics>()
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  for (const it of items ?? []) {
    const m = metricsByProject.get(it.project_id) ?? blankMetrics()
    m.total += 1
    if (it.status === "complete") m.complete += 1
    if (it.status === "delayed") m.delayed += 1
    if (it.status === "in_progress") m.inProgress += 1
    // "Past due" = end_date or due_date is in the past AND status != complete.
    const dateStr = it.end_date ?? it.due_date
    if (dateStr && it.status !== "complete") {
      const d = new Date(dateStr + "T00:00:00Z")
      if (d.getTime() < today.getTime()) m.pastDue += 1
    }
    metricsByProject.set(it.project_id, m)
  }
  const approvedDeltaByProject = new Map<string, number>()
  for (const d of approvedDecisions ?? []) {
    const prev = approvedDeltaByProject.get(d.project_id) ?? 0
    approvedDeltaByProject.set(
      d.project_id,
      prev + (Number(d.cost_delta) || 0)
    )
  }

  // Portfolio aggregates. Only active-for-health projects contribute to the
  // headline counters; the contract / changes totals span every visible
  // project so a PM closing the books on a recently-completed job still
  // sees its cost growth here.
  const visibleProjects = projects ?? []
  const activeProjects = visibleProjects.filter((p) =>
    PORTFOLIO_ACTIVE.includes(p.status)
  )
  let activeOnTrack = 0
  let activeDelayed = 0
  for (const p of activeProjects) {
    const m = metricsByProject.get(p.id) ?? blankMetrics()
    if (m.delayed > 0 || m.pastDue > 0) activeDelayed += 1
    else activeOnTrack += 1
  }
  const totalContract = visibleProjects.reduce(
    (sum, p) => sum + Number(p.contract_price ?? 0),
    0
  )
  const totalApprovedDelta = Array.from(approvedDeltaByProject.values()).reduce(
    (sum, n) => sum + n,
    0
  )
  const growthPct =
    totalContract > 0 ? (totalApprovedDelta / totalContract) * 100 : 0

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {profile.role === "staff" ? (
        <FeedbackNotification />
      ) : (
        <MyFeedbackNotification
          userId={profile.id}
          email={profile.email ?? ""}
        />
      )}
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted">
            {visibleProjects.length} project
            {visibleProjects.length === 1 ? "" : "s"} · {activeProjects.length}{" "}
            active
          </p>
        </div>
        {profile.role === "staff" && (
          <Link href="/projects/new">
            <Button>
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </Link>
        )}
      </div>

      {activeProjects.length > 0 && (
        <div
          className={cn(
            "grid gap-3 mb-6",
            profile.financial_access
              ? "grid-cols-2 md:grid-cols-4"
              : "grid-cols-2"
          )}
        >
          <PortfolioStat
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="On track"
            value={String(activeOnTrack)}
            sub={`of ${activeProjects.length} active`}
            tone={activeOnTrack === activeProjects.length ? "success" : undefined}
          />
          <PortfolioStat
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Behind"
            value={String(activeDelayed)}
            sub={activeDelayed > 0 ? "delayed or past due" : "none — nice"}
            tone={activeDelayed > 0 ? "danger" : "success"}
          />
          {profile.financial_access && (
          <PortfolioStat
            icon={<Activity className="h-4 w-4" />}
            label="Contract value"
            value={formatCurrency(totalContract)}
            sub="across all projects"
          />
          )}
          {profile.financial_access && (
          <PortfolioStat
            icon={<TrendingUp className="h-4 w-4" />}
            label="Cost growth"
            value={
              (totalApprovedDelta >= 0 ? "+" : "") +
              formatCurrency(totalApprovedDelta)
            }
            sub={
              totalContract > 0
                ? `${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}% of contract`
                : "no contract value"
            }
            tone={totalApprovedDelta > 0 ? "warning" : undefined}
          />
          )}
        </div>
      )}

      {!projects || projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-10 w-10" />}
          title="No projects yet"
          description={
            profile.role === "staff"
              ? "Create your first project to get started."
              : "You don't have access to any projects yet."
          }
          action={
            profile.role === "staff" ? (
              <Link href="/projects/new">
                <Button>
                  <Plus className="h-4 w-4" />
                  New project
                </Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs text-muted uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Project #</th>
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">
                  Address
                </th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-left font-medium px-4 py-2.5 hidden xl:table-cell">
                  Progress
                </th>
                <th className="text-left font-medium px-4 py-2.5 hidden xl:table-cell">
                  Schedule
                </th>
                {profile.financial_access && (
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Contract
                  </th>
                )}
                {profile.financial_access && (
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Changes
                  </th>
                )}
                <th className="text-left font-medium px-4 py-2.5 hidden lg:table-cell">
                  Target
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {projects.map((p) => {
                const m = metricsByProject.get(p.id) ?? blankMetrics()
                const pct =
                  m.total > 0 ? Math.round((m.complete / m.total) * 100) : 0
                const delta = approvedDeltaByProject.get(p.id) ?? 0
                return (
                  <tr
                    key={p.id}
                    className="hover:bg-background/60 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        href={`/projects/${p.id}/schedule`}
                        className="text-brand-600 hover:underline"
                      >
                        {p.project_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/projects/${p.id}/schedule`}
                        className="hover:underline"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted hidden md:table-cell truncate max-w-xs">
                      {p.address || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[p.status]}>
                        {STATUS_LABEL[p.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell">
                      {m.total > 0 ? (
                        <ProgressBar pct={pct} />
                      ) : (
                        <span className="text-muted text-xs">no items</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell text-xs">
                      <ScheduleHealth metrics={m} status={p.status} />
                    </td>
                    {profile.financial_access && (
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                        {formatCurrency(p.contract_price)}
                      </td>
                    )}
                    {profile.financial_access && (
                      <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                        {delta === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span
                            className={cn(
                              delta > 0 ? "text-amber-900" : "text-success"
                            )}
                          >
                            {(delta > 0 ? "+" : "") + formatCurrency(delta)}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-muted hidden lg:table-cell">
                      {formatDate(p.target_completion_date)}
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

type ScheduleSlim = {
  project_id: string
  kind: Enums<"schedule_item_kind">
  status: Enums<"schedule_item_status">
  end_date: string | null
  due_date: string | null
}

type DecisionSlim = {
  project_id: string
  cost_delta: number | null
}

type ProjectMetrics = {
  total: number
  complete: number
  delayed: number
  inProgress: number
  pastDue: number
}

function blankMetrics(): ProjectMetrics {
  return {
    total: 0,
    complete: 0,
    delayed: 0,
    inProgress: 0,
    pastDue: 0,
  }
}

function PortfolioStat({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  tone?: "success" | "warning" | "danger"
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-amber-900"
        : tone === "danger"
          ? "text-danger"
          : "text-foreground"
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs uppercase text-muted tracking-wide flex items-center gap-1.5">
          {icon}
          {label}
        </div>
        <div className={cn("text-xl font-semibold tabular-nums mt-1", toneClass)}>
          {value}
        </div>
        {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
      </CardBody>
    </Card>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2 w-32">
      <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full",
            clamped >= 100
              ? "bg-success"
              : clamped >= 60
                ? "bg-brand-500"
                : "bg-amber-500"
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-muted tabular-nums">{clamped}%</span>
    </div>
  )
}

function ScheduleHealth({
  metrics,
  status,
}: {
  metrics: ProjectMetrics
  status: Enums<"project_status">
}) {
  if (metrics.total === 0) return <span className="text-muted">—</span>
  if (status === "complete" || status === "cancelled") {
    return <span className="text-muted">closed</span>
  }
  // Order matters: a past-due item is louder than a same-day "in progress",
  // and "delayed" status outranks both. Pick the loudest signal so the row
  // gives a one-glance health read without the PM scanning numbers.
  if (metrics.delayed > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-danger">
        <AlertTriangle className="h-3 w-3" />
        {metrics.delayed} delayed
      </span>
    )
  }
  if (metrics.pastDue > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-900">
        <AlertTriangle className="h-3 w-3" />
        {metrics.pastDue} past due
      </span>
    )
  }
  if (metrics.inProgress > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-brand-700">
        <Activity className="h-3 w-3" />
        {metrics.inProgress} in progress
      </span>
    )
  }
  return <span className="text-muted">on track</span>
}
