"use client"

import { useState, useMemo } from "react"
import {
  Plus,
  FilePen,
  Scale,
  Palette,
  Search,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input, Select } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate, cn } from "@/lib/utils"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"
import { DecisionDrawer } from "@/components/decisions/decision-drawer"

export type DecisionsData = {
  project_id: string
  role: UserRole
  me_id: string
  me_name: string
  decisions: Tables<"decisions">[]
  followups: Tables<"decision_followup_templates">[]
  attachments: Tables<"decision_attachments">[]
  comments: Tables<"decision_comments">[]
  profiles: Pick<Tables<"profiles">, "id" | "full_name" | "email" | "role">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  // Cost line items are visible to staff only (RLS-enforced). For clients
  // this is always an empty array — they only see the rolled-up cost_delta.
  cost_items: Tables<"decision_cost_items">[]
  cost_codes: Pick<Tables<"cost_codes">, "id" | "code" | "name" | "position" | "is_active">[]
  choices: Tables<"decision_choices">[]
  signed_urls: Record<string, string>
}

type KindFilter = "all" | "change_order" | "selection"
type StatusFilter = "all" | "open" | Enums<"decision_status">

export function DecisionsClient({ data }: { data: DecisionsData }) {
  const [drawerState, setDrawerState] = useState<
    | { mode: "create"; kind?: "change_order" | "selection" }
    | { mode: "edit"; decisionId: string }
    | null
  >(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [query, setQuery] = useState("")

  const canEdit = data.role === "staff"
  const editingDecision =
    drawerState?.mode === "edit"
      ? data.decisions.find((d) => d.id === drawerState.decisionId)
      : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.decisions.filter((d) => {
      if (kindFilter !== "all" && d.kind !== kindFilter) return false
      if (statusFilter === "open") {
        if (d.status !== "draft" && d.status !== "pending_client") return false
      } else if (statusFilter !== "all" && d.status !== statusFilter) {
        return false
      }
      if (q) {
        const hay = `${d.number} ${d.title} ${d.description ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data.decisions, kindFilter, statusFilter, query])

  const stats = useMemo(() => {
    const open = data.decisions.filter(
      (d) => d.status === "draft" || d.status === "pending_client"
    ).length
    const approvedDelta = data.decisions
      .filter((d) => d.status === "approved")
      .reduce((sum, d) => sum + (Number(d.cost_delta) || 0), 0)
    return {
      total: data.decisions.length,
      open,
      approvedDelta,
    }
  }, [data.decisions])

  const commentCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of data.comments) {
      m.set(c.decision_id, (m.get(c.decision_id) ?? 0) + 1)
    }
    return m
  }, [data.comments])

  const filtersActive =
    kindFilter !== "all" || statusFilter !== "all" || query.trim() !== ""

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-6 text-sm">
          <Stat label="Total" value={String(stats.total)} />
          <Stat label="Open" value={String(stats.open)} />
          <Stat
            label="Approved cost delta"
            value={formatCurrency(stats.approvedDelta)}
            tone={stats.approvedDelta < 0 ? "success" : "neutral"}
          />
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setDrawerState({ mode: "create", kind: "selection" })
              }
            >
              <Plus className="h-3.5 w-3.5" /> Selection
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setDrawerState({ mode: "create", kind: "change_order" })
              }
            >
              <Plus className="h-3.5 w-3.5" /> Change order
            </Button>
          </div>
        )}
      </div>

      {data.decisions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or description"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <Select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="h-8 w-auto text-xs"
          >
            <option value="all">All types</option>
            <option value="change_order">Change orders</option>
            <option value="selection">Selections</option>
          </Select>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-8 w-auto text-xs"
          >
            <option value="all">All statuses</option>
            <option value="open">Open (draft + pending)</option>
            <option value="draft">Draft</option>
            <option value="pending_client">Pending client</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setKindFilter("all")
                setStatusFilter("all")
                setQuery("")
              }}
              className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          <span className="text-xs text-muted ml-auto">
            {filtered.length} of {data.decisions.length}
          </span>
        </div>
      )}

      {data.decisions.length === 0 ? (
        <EmptyState
          icon={<FilePen className="h-10 w-10" />}
          title="No decisions yet"
          description={
            canEdit
              ? "Track everything the homeowner needs to decide after contract — paint colors, fixtures, change orders. Approvals can auto-create follow-up to-dos."
              : "Nothing to review yet."
          }
          action={
            canEdit ? (
              <Button
                onClick={() =>
                  setDrawerState({ mode: "create", kind: "change_order" })
                }
              >
                <Plus className="h-4 w-4" /> Change order
              </Button>
            ) : null
          }
        />
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg px-4 py-8 text-center text-sm text-muted">
          No decisions match the current filters.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left font-medium px-4 py-2.5 w-16">#</th>
                <th className="text-left font-medium px-4 py-2.5 w-32">Type</th>
                <th className="text-left font-medium px-4 py-2.5">Title</th>
                <th className="text-left font-medium px-4 py-2.5 w-36">Status</th>
                <th className="text-left font-medium px-4 py-2.5 w-28 hidden md:table-cell">
                  Due
                </th>
                <th className="text-right font-medium px-4 py-2.5 w-32">Cost delta</th>
                <th className="text-left font-medium px-4 py-2.5 w-24 hidden md:table-cell">
                  Comments
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((d) => {
                const commentCount = commentCounts.get(d.id) ?? 0
                return (
                  <tr
                    key={d.id}
                    className="hover:bg-background/40 cursor-pointer"
                    onClick={() =>
                      setDrawerState({ mode: "edit", decisionId: d.id })
                    }
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted tabular-nums">
                      #{d.number}
                    </td>
                    <td className="px-4 py-3">
                      <KindChip kind={d.kind} />
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <div>{d.title}</div>
                      {d.allowance_amount != null && (
                        <div className="text-[11px] text-muted font-normal mt-0.5">
                          Allowance {formatCurrency(Number(d.allowance_amount))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs">
                      <DueCell due={d.due_date} status={d.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <CostDelta value={d.cost_delta} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted">
                      {commentCount > 0 ? commentCount : "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawerState && (
        <DecisionDrawer
          open={true}
          onClose={() => setDrawerState(null)}
          data={data}
          mode={drawerState.mode === "edit" ? "edit" : "create"}
          decision={editingDecision ?? undefined}
          defaultKind={
            drawerState.mode === "create" ? drawerState.kind : undefined
          }
        />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "success" | "neutral"
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "success" && "text-success"
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function KindChip({ kind }: { kind: Enums<"decision_kind"> }) {
  if (kind === "change_order") {
    return (
      <Badge tone="warning">
        <Scale className="h-3 w-3" /> Change order
      </Badge>
    )
  }
  return (
    <Badge tone="info">
      <Palette className="h-3 w-3" /> Selection
    </Badge>
  )
}

export function StatusBadge({ status }: { status: Enums<"decision_status"> }) {
  const map = {
    draft: { label: "Draft", tone: "muted" as const },
    pending_client: { label: "Pending client", tone: "warning" as const },
    approved: { label: "Approved", tone: "success" as const },
    rejected: { label: "Rejected", tone: "danger" as const },
  }
  const { label, tone } = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

export function CostDelta({ value }: { value: number | null }) {
  if (value == null || value === 0) return <span className="text-muted">—</span>
  const positive = value > 0
  return (
    <span className={positive ? "text-foreground" : "text-success"}>
      {positive ? "+" : ""}
      {formatCurrency(value)}
    </span>
  )
}

// Highlight a missed due date in red, but only while the decision is still
// open. Once approved/rejected the date is just historical context.
function DueCell({
  due,
  status,
}: {
  due: string | null
  status: Enums<"decision_status">
}) {
  if (!due) return <span className="text-muted">—</span>
  const isOpen = status === "draft" || status === "pending_client"
  const overdue = isOpen && due < new Date().toISOString().slice(0, 10)
  return (
    <span className={overdue ? "text-danger font-medium" : "text-foreground"}>
      {formatDate(due)}
    </span>
  )
}

export function dateOrNow(value: string | null | undefined) {
  return value ? formatDate(value) : formatDate(new Date())
}
