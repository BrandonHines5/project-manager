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
import { EmptyState } from "@/components/ui/empty"
import { Card, CardBody } from "@/components/ui/card"
import { FeedbackNotification } from "@/components/feedback/feedback-notification"
import { MyFeedbackNotification } from "@/components/feedback/my-feedback-notification"
import { cn, formatCurrency } from "@/lib/utils"
import { ProjectsTable, type ProjectRow } from "./projects-table"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Projects — Hines Homes" }

// A project counts as "active for portfolio health" when it's in one of these
// statuses. Paused / complete / warranty / cancelled are excluded from the
// on-time / delayed roll-up because they aren't a live build the PM team is
// pushing against today.
const PORTFOLIO_ACTIVE: Enums<"project_status">[] = [
  "upcoming",
  "in_work",
  "inventory",
]

export default async function ProjectsPage() {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data: projects } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, address, status, crm_status, contract_price, start_date, target_completion_date, dashboard_url, is_template, labels"
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

  // Serializable rows for the client filter/table. Metrics are pre-rolled on
  // the server so the client component stays purely presentational.
  const rows: ProjectRow[] = visibleProjects.map((p) => ({
    id: p.id,
    project_number: p.project_number,
    name: p.name,
    address: p.address,
    status: p.status,
    crm_status: p.crm_status,
    contract_price: p.contract_price,
    target_completion_date: p.target_completion_date,
    is_template: p.is_template,
    labels: p.labels ?? [],
    metrics: metricsByProject.get(p.id) ?? blankMetrics(),
    delta: approvedDeltaByProject.get(p.id) ?? 0,
  }))

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {profile.role === "staff" ? (
        <FeedbackNotification />
      ) : (
        <MyFeedbackNotification userId={profile.id} />
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
        <ProjectsTable rows={rows} financialAccess={profile.financial_access} />
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
