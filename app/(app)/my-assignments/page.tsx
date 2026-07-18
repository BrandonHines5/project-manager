import Link from "next/link"
import {
  CalendarDays,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Palette,
} from "lucide-react"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatDate, formatDateRange } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "My assignments — BuildFox" }

const STATUS_TONE: Record<
  Enums<"schedule_item_status">,
  "muted" | "info" | "success" | "danger"
> = {
  not_started: "muted",
  in_progress: "info",
  complete: "success",
  delayed: "danger",
}

const STATUS_LABEL: Record<Enums<"schedule_item_status">, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  delayed: "Delayed",
}

const PRIORITY_TONE: Record<
  Enums<"todo_priority">,
  "muted" | "warning" | "danger"
> = {
  low: "muted",
  medium: "warning",
  high: "danger",
}

export default async function MyAssignmentsPage() {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  // RLS already filters schedule_items for trades — they see only items
  // assigned to their profile or their company. We still do an explicit
  // assignment lookup so we can group by project nicely.
  const { data: assignments, error: aErr } = await supabase
    .from("schedule_assignments")
    .select(
      `schedule_item_id, profile_id, company_id,
       schedule_items!inner (
         id, project_id, kind, title, status, priority,
         start_date, end_date, due_date,
         projects!inner ( id, name, project_number, address )
       )`
    )
    .or(
      profile.company_id
        ? `profile_id.eq.${profile.id},company_id.eq.${profile.company_id}`
        : `profile_id.eq.${profile.id}`
    )
  if (aErr) throw new Error(aErr.message)

  type Row = {
    id: string
    project_id: string
    project_number: string
    project_name: string
    kind: "work" | "todo"
    title: string
    status: Enums<"schedule_item_status">
    priority: Enums<"todo_priority"> | null
    start_date: string | null
    end_date: string | null
    due_date: string | null
  }

  const rows: Row[] = []
  const seen = new Set<string>()
  for (const a of assignments ?? []) {
    const item = a.schedule_items as unknown as {
      id: string
      project_id: string
      kind: "work" | "todo"
      title: string
      status: Enums<"schedule_item_status">
      priority: Enums<"todo_priority"> | null
      start_date: string | null
      end_date: string | null
      due_date: string | null
      projects: { id: string; name: string; project_number: string }
    }
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    rows.push({
      id: item.id,
      project_id: item.project_id,
      project_number: item.projects.project_number,
      project_name: item.projects.name,
      kind: item.kind,
      title: item.title,
      status: item.status,
      priority: item.priority,
      start_date: item.start_date,
      end_date: item.end_date,
      due_date: item.due_date,
    })
  }

  // Role-based assignments: a template assigns its items to roles, and each
  // project maps the role to a person/company. Pull in items whose role
  // resolves to me (or my company) on a project — they have no direct
  // profile_id/company_id, so the query above misses them. Two steps: find the
  // (project, role) pairs that map to me, then fetch role assignments for
  // those roles and keep only the ones on a matching project.
  const orFilter = profile.company_id
    ? `profile_id.eq.${profile.id},company_id.eq.${profile.company_id}`
    : `profile_id.eq.${profile.id}`
  const { data: myRoleMemberships, error: rmErr } = await supabase
    .from("project_role_members")
    .select("project_id, role_id")
    .or(orFilter)
  if (rmErr) throw new Error(rmErr.message)

  if (myRoleMemberships && myRoleMemberships.length > 0) {
    const myRoleKeys = new Set(
      myRoleMemberships.map((m) => `${m.project_id}|${m.role_id}`)
    )
    const myRoleIds = [...new Set(myRoleMemberships.map((m) => m.role_id))]
    const myProjectIds = [
      ...new Set(myRoleMemberships.map((m) => m.project_id)),
    ]
    // Constrain by both role_id AND the joined item's project_id so an org-wide
    // role (e.g. "Project Manager") doesn't pull every assignment for that role
    // across all projects before the in-memory (project,role) pair check.
    const { data: roleAssignments, error: raErr } = await supabase
      .from("schedule_assignments")
      .select(
        `schedule_item_id, role_id,
         schedule_items!inner (
           id, project_id, kind, title, status, priority,
           start_date, end_date, due_date,
           projects!inner ( id, name, project_number, address )
         )`
      )
      .in("role_id", myRoleIds)
      .in("schedule_items.project_id", myProjectIds)
    if (raErr) throw new Error(raErr.message)

    for (const a of roleAssignments ?? []) {
      const item = a.schedule_items as unknown as {
        id: string
        project_id: string
        kind: "work" | "todo"
        title: string
        status: Enums<"schedule_item_status">
        priority: Enums<"todo_priority"> | null
        start_date: string | null
        end_date: string | null
        due_date: string | null
        projects: { id: string; name: string; project_number: string }
      }
      if (!item || seen.has(item.id)) continue
      // Only keep items whose role maps to me on THIS project.
      if (!myRoleKeys.has(`${item.project_id}|${a.role_id}`)) continue
      seen.add(item.id)
      rows.push({
        id: item.id,
        project_id: item.project_id,
        project_number: item.projects.project_number,
        project_name: item.projects.name,
        kind: item.kind,
        title: item.title,
        status: item.status,
        priority: item.priority,
        start_date: item.start_date,
        end_date: item.end_date,
        due_date: item.due_date,
      })
    }
  }

  // Selections assigned to me / my company / my roles (decision_assignments,
  // 0075). Same two-pass shape as the schedule: direct assignments first,
  // then role assignments resolved through project_role_members. RLS already
  // hides drafts (and everything unassigned) from trades; the explicit
  // status filter keeps staff views consistent with what subs see.
  type SelectionRow = {
    id: string
    project_id: string
    project_number: string
    project_name: string
    title: string
    status: Enums<"decision_status">
    due_date: string | null
  }
  type SelectionJoin = {
    id: string
    project_id: string
    kind: Enums<"decision_kind">
    title: string
    status: Enums<"decision_status">
    due_date: string | null
    projects: { id: string; name: string; project_number: string }
  }
  const selectionRows: SelectionRow[] = []
  const seenSelections = new Set<string>()
  const pushSelection = (d: SelectionJoin | null | undefined) => {
    if (!d || d.kind !== "selection" || d.status === "draft") return
    if (seenSelections.has(d.id)) return
    seenSelections.add(d.id)
    selectionRows.push({
      id: d.id,
      project_id: d.project_id,
      project_number: d.projects.project_number,
      project_name: d.projects.name,
      title: d.title,
      status: d.status,
      due_date: d.due_date,
    })
  }

  const { data: decisionAssignments, error: daErr } = await supabase
    .from("decision_assignments")
    .select(
      `decision_id, profile_id, company_id,
       decisions!inner (
         id, project_id, kind, title, status, due_date,
         projects!inner ( id, name, project_number )
       )`
    )
    .or(
      profile.company_id
        ? `profile_id.eq.${profile.id},company_id.eq.${profile.company_id}`
        : `profile_id.eq.${profile.id}`
    )
  if (daErr) throw new Error(daErr.message)
  for (const a of decisionAssignments ?? []) {
    pushSelection(a.decisions as unknown as SelectionJoin)
  }

  if (myRoleMemberships && myRoleMemberships.length > 0) {
    const myRoleKeys = new Set(
      myRoleMemberships.map((m) => `${m.project_id}|${m.role_id}`)
    )
    const myRoleIds = [...new Set(myRoleMemberships.map((m) => m.role_id))]
    const myProjectIds = [
      ...new Set(myRoleMemberships.map((m) => m.project_id)),
    ]
    const { data: roleDecisionAssignments, error: rdaErr } = await supabase
      .from("decision_assignments")
      .select(
        `decision_id, role_id,
         decisions!inner (
           id, project_id, kind, title, status, due_date,
           projects!inner ( id, name, project_number )
         )`
      )
      .in("role_id", myRoleIds)
      .in("decisions.project_id", myProjectIds)
    if (rdaErr) throw new Error(rdaErr.message)
    for (const a of roleDecisionAssignments ?? []) {
      const d = a.decisions as unknown as SelectionJoin
      if (!d || !myRoleKeys.has(`${d.project_id}|${a.role_id}`)) continue
      pushSelection(d)
    }
  }

  selectionRows.sort((a, b) => {
    const aDone = a.status !== "pending_client"
    const bDone = b.status !== "pending_client"
    if (aDone !== bDone) return aDone ? 1 : -1
    if (a.due_date == null && b.due_date == null) return 0
    if (a.due_date == null) return 1
    if (b.due_date == null) return -1
    return a.due_date.localeCompare(b.due_date)
  })

  // Sort: incomplete first, then by earliest of (start_date, due_date)
  rows.sort((a, b) => {
    const aDone = a.status === "complete"
    const bDone = b.status === "complete"
    if (aDone !== bDone) return aDone ? 1 : -1
    const aDate = a.kind === "work" ? a.start_date : a.due_date
    const bDate = b.kind === "work" ? b.start_date : b.due_date
    if (aDate == null && bDate == null) return 0
    if (aDate == null) return 1
    if (bDate == null) return -1
    return aDate.localeCompare(bDate)
  })

  const openCount =
    rows.filter((r) => r.status !== "complete").length +
    selectionRows.filter((s) => s.status === "pending_client").length
  const delayedCount = rows.filter((r) => r.status === "delayed").length
  const totalCount = rows.length + selectionRows.length

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold">My assignments</h1>
        <p className="text-sm text-muted mt-1">
          Everything assigned to you{profile.company_id ? " or your company" : ""}, across all projects.
        </p>
      </div>

      <div className="flex items-center gap-6 mb-4 text-sm">
        <div>
          <div className="text-xs text-muted uppercase tracking-wide">Open</div>
          <div className="text-xl font-semibold tabular-nums">{openCount}</div>
        </div>
        <div>
          <div className="text-xs text-muted uppercase tracking-wide">Delayed</div>
          <div
            className={
              "text-xl font-semibold tabular-nums " +
              (delayedCount > 0 ? "text-danger" : "")
            }
          >
            {delayedCount}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted uppercase tracking-wide">Total</div>
          <div className="text-xl font-semibold tabular-nums">{totalCount}</div>
        </div>
      </div>

      {rows.length === 0 && selectionRows.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-10 w-10" />}
          title="Nothing assigned yet"
          description="Items assigned to you will appear here as your projects schedule work."
        />
      ) : rows.length === 0 ? null : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const dateLabel =
                r.kind === "work"
                  ? formatDateRange(r.start_date, r.end_date)
                  : r.due_date
                    ? `Due ${formatDate(r.due_date)}`
                    : "—"
              return (
                <li key={r.id} className="px-4 py-3">
                  <Link
                    href={`/projects/${r.project_id}/schedule`}
                    className="flex items-start gap-3 group"
                  >
                    <div className="mt-0.5">
                      {r.status === "complete" ? (
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      ) : (
                        <Circle className="h-4 w-4 text-muted" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={
                            "text-sm font-medium group-hover:text-brand-600 " +
                            (r.status === "complete"
                              ? "line-through text-muted"
                              : "text-foreground")
                          }
                        >
                          {r.title}
                        </span>
                        <Badge tone={STATUS_TONE[r.status]}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                        {r.priority === "high" && (
                          <Badge tone={PRIORITY_TONE[r.priority]}>
                            {r.priority} priority
                          </Badge>
                        )}
                        {r.status === "delayed" && (
                          <AlertTriangle className="h-3 w-3 text-danger" />
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                        <span className="font-mono">{r.project_number}</span>
                        <span className="truncate">{r.project_name}</span>
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          {dateLabel}
                        </span>
                        <span className="capitalize">
                          {r.kind === "work" ? "Work" : "To-do"}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {selectionRows.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-1">Selections</h2>
          <p className="text-sm text-muted mb-3">
            Selections you&apos;re assigned on — open one to see the choices
            and photos.
          </p>
          <Card>
            <ul className="divide-y divide-border">
              {selectionRows.map((s) => (
                <li key={s.id} className="px-4 py-3">
                  <Link
                    href={`/projects/${s.project_id}/decisions?open=${s.id}`}
                    className="flex items-start gap-3 group"
                  >
                    <div className="mt-0.5">
                      <Palette className="h-4 w-4 text-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground group-hover:text-brand-600">
                          {s.title}
                        </span>
                        <Badge tone={DECISION_STATUS_TONE[s.status]}>
                          {DECISION_STATUS_LABEL[s.status]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                        <span className="font-mono">{s.project_number}</span>
                        <span className="truncate">{s.project_name}</span>
                        {s.due_date && (
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            Due {formatDate(s.due_date)}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  )
}

const DECISION_STATUS_TONE: Record<
  Enums<"decision_status">,
  "muted" | "warning" | "success" | "danger"
> = {
  draft: "muted",
  pending_client: "warning",
  approved: "success",
  rejected: "danger",
}

const DECISION_STATUS_LABEL: Record<Enums<"decision_status">, string> = {
  draft: "Draft",
  pending_client: "Awaiting client",
  approved: "Approved",
  rejected: "Declined",
}
