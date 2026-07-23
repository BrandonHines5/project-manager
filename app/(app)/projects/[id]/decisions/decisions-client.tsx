"use client"

import { useState, useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { toastActionError } from "@/lib/action-error"
import {
  Plus,
  FilePen,
  Scale,
  Palette,
  Search,
  X,
  CalendarClock,
  Download,
  Copy,
  Pencil,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input, Select } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate, cn } from "@/lib/utils"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"
import { DecisionDrawer } from "@/components/decisions/decision-drawer"
import {
  bulkCopyDecisions,
  saveDecisionDisclaimer,
} from "@/app/actions/decisions"
import { makeXlsx, type XlsxCell } from "@/lib/export/xlsx"
import { TemplateTagBadges } from "@/components/template-tag-badges"

export type DecisionsData = {
  project_id: string
  role: UserRole
  me_id: string
  me_name: string
  // Template projects show each decision's template-tag chips on the list
  // (the drawer edits them everywhere; they're inert on real jobs).
  is_template: boolean
  open_decision_id: string | null
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
  // Work items in this project — follow-ups can anchor their date to one.
  work_items: Pick<
    Tables<"schedule_items">,
    "id" | "title" | "start_date" | "end_date"
  >[]
  // Projects the caller can see — copy destinations.
  projects: Pick<Tables<"projects">, "id" | "name" | "project_number">[]
  // People / companies / roles each decision is assigned to (0075). Empty for
  // clients (no RLS policy); trades see only rows targeting them.
  assignments: Tables<"decision_assignments">[]
  roles: Pick<Tables<"roles">, "id" | "name" | "kind">[]
  roleMembers: Pick<
    Tables<"project_role_members">,
    "role_id" | "profile_id" | "company_id"
  >[]
  // Org-wide disclaimer footer shown to clients at the bottom of every
  // decision (app_settings key 'decision_disclaimer').
  disclaimer: string | null
  signed_urls: Record<string, string>
}

type KindFilter = "all" | "change_order" | "selection"
type StatusFilter = "all" | "open" | Enums<"decision_status">

type SortKey =
  | "number"
  | "kind"
  | "title"
  | "status"
  | "due"
  | "cost"
  | "comments"

// Workflow order, not alphabetical — the enum's alphabetical order
// (approved < draft < pending_client < rejected) is meaningless to users.
const STATUS_RANK: Record<Enums<"decision_status">, number> = {
  draft: 0,
  pending_client: 1,
  approved: 2,
  rejected: 3,
}

export function DecisionsClient({ data }: { data: DecisionsData }) {
  const [drawerState, setDrawerState] = useState<
    | { mode: "create"; kind?: "change_order" | "selection" }
    | { mode: "edit"; decisionId: string }
    | null
  >(
    data.open_decision_id
      ? { mode: "edit", decisionId: data.open_decision_id }
      : null
  )
  const [kindFilter, setKindFilter] = useState<KindFilter>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [query, setQuery] = useState("")
  // Click-to-sort on the table headings. Default matches the server order
  // (newest number first).
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "number",
    dir: "desc",
  })
  function toggleSort(key: SortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : // Fresh column: text-ish columns start ascending, numeric-ish
          // columns start with the big/new values on top.
          {
            key,
            dir:
              key === "number" || key === "cost" || key === "comments"
                ? "desc"
                : "asc",
          }
    )
  }
  // Multi-select for the bulk "copy to job" bar (staff only).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set()
  )

  const canEdit = data.role === "staff"

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
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

  // Declared after commentCounts on purpose — the comments column sorts on it.
  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1
    // Nullable columns keep nulls at the bottom in BOTH directions — an
    // undated decision shouldn't jump to the top just because you flipped
    // the Due sort.
    const cmp = (a: (typeof filtered)[number], b: (typeof filtered)[number]) => {
      switch (sort.key) {
        case "number":
          return (a.number - b.number) * dir
        case "kind":
          return a.kind.localeCompare(b.kind) * dir
        case "title":
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) * dir
        case "status":
          return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir
        case "due": {
          if (!a.due_date && !b.due_date) return 0
          if (!a.due_date) return 1
          if (!b.due_date) return -1
          return a.due_date.localeCompare(b.due_date) * dir
        }
        case "cost": {
          const av = a.cost_delta == null ? null : Number(a.cost_delta) || 0
          const bv = b.cost_delta == null ? null : Number(b.cost_delta) || 0
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return (av - bv) * dir
        }
        case "comments":
          return (
            ((commentCounts.get(a.id) ?? 0) - (commentCounts.get(b.id) ?? 0)) *
            dir
          )
      }
    }
    return [...filtered].sort(
      // Stable tie-break: newest number first, regardless of direction.
      (a, b) => cmp(a, b) || b.number - a.number
    )
  }, [filtered, sort, commentCounts])

  // Titles for due-date-linked schedule items. Clients can't read the
  // schedule, so their lookup misses and the tooltip falls back to a
  // generic label.
  const workItemTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of data.work_items) m.set(w.id, w.title)
    return m
  }, [data.work_items])

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
            {data.decisions.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => exportDecisionsXlsx(data)}
                title="Download every change order and selection (with choices and line items) as a spreadsheet"
              >
                <Download className="h-3.5 w-3.5" /> Export
              </Button>
            )}
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

      {canEdit && <DisclaimerEditor initial={data.disclaimer} />}

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
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          {/* overflow-x-auto, not -hidden: on a phone the row content can
              exceed the viewport, and clipping made the right columns
              unreachable. The tightened sub-sm padding on cells keeps the
              table fitting without a scrollbar on most phones. */}
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                {canEdit && (
                  <th className="px-2 sm:px-3 py-2.5 w-8">
                    <span className="sr-only">Select</span>
                  </th>
                )}
                <SortableTh
                  label="#"
                  sortKey="number"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-16"
                />
                {/* The KindChip repeats in the drawer; the Title column is what
                    a phone needs, so Type joins Due/Comments as md-and-up. */}
                <SortableTh
                  label="Type"
                  sortKey="kind"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-32 hidden md:table-cell"
                />
                <SortableTh
                  label="Title"
                  sortKey="title"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortableTh
                  label="Status"
                  sortKey="status"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-28 md:w-36"
                />
                <SortableTh
                  label="Due"
                  sortKey="due"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-28 hidden md:table-cell"
                />
                <SortableTh
                  label="Cost delta"
                  sortKey="cost"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-32"
                  align="right"
                />
                <SortableTh
                  label="Comments"
                  sortKey="comments"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-24 hidden md:table-cell"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((d) => {
                const commentCount = commentCounts.get(d.id) ?? 0
                return (
                  <tr
                    key={d.id}
                    className="hover:bg-background/40 cursor-pointer"
                    onClick={() =>
                      setDrawerState({ mode: "edit", decisionId: d.id })
                    }
                  >
                    {canEdit && (
                      <td
                        className="px-2 sm:px-3 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(d.id)}
                          onChange={() => toggleSelected(d.id)}
                          aria-label={`Select #${d.number} ${d.title}`}
                          className="h-4 w-4 cursor-pointer"
                        />
                      </td>
                    )}
                    <td className="px-2 sm:px-4 py-3 font-mono text-xs text-muted tabular-nums">
                      #{d.number}
                    </td>
                    <td className="px-2 sm:px-4 py-3 hidden md:table-cell">
                      <KindChip kind={d.kind} />
                    </td>
                    <td className="px-2 sm:px-4 py-3 font-medium">
                      <div>{d.title}</div>
                      {d.allowance_amount != null && (
                        <div className="text-[11px] text-muted font-normal mt-0.5">
                          Allowance {formatCurrency(Number(d.allowance_amount))}
                        </div>
                      )}
                      {data.is_template && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          <TemplateTagBadges tags={d.template_tags} />
                        </div>
                      )}
                    </td>
                    <td className="px-2 sm:px-4 py-3">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-2 sm:px-4 py-3 hidden md:table-cell text-xs">
                      <DueCell
                        due={d.due_date}
                        status={d.status}
                        linkedTo={
                          d.due_anchor_schedule_item_id
                            ? workItemTitleById.get(
                                d.due_anchor_schedule_item_id
                              ) ?? "the schedule"
                            : null
                        }
                      />
                    </td>
                    <td className="px-2 sm:px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      <CostDelta value={d.cost_delta} />
                    </td>
                    <td className="px-2 sm:px-4 py-3 hidden md:table-cell text-muted">
                      {commentCount > 0 ? commentCount : "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <BulkCopyBar
          projectId={data.project_id}
          selectedIds={Array.from(selectedIds)}
          projects={data.projects.filter((p) => p.id !== data.project_id)}
          onClear={() => setSelectedIds(new Set())}
        />
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

/**
 * Floating bar shown while decisions are checked — mirrors the schedule's
 * BulkActionsBar but with a single action: copy the selection to another job
 * (each copy lands as a fresh draft with a new number; approvals/choices
 * reset, cross-project schedule links dropped).
 */
function BulkCopyBar({
  projectId,
  selectedIds,
  projects,
  onClear,
}: {
  projectId: string
  selectedIds: string[]
  projects: Pick<Tables<"projects">, "id" | "name" | "project_number">[]
  onClear: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [targetProjectId, setTargetProjectId] = useState<string>(
    projects[0]?.id ?? ""
  )
  if (selectedIds.length === 0) return null

  function runCopy() {
    if (!targetProjectId) {
      toast.error("Pick a job to copy into.")
      return
    }
    const target = projects.find((p) => p.id === targetProjectId)
    const targetLabel = target
      ? `${target.project_number != null ? `${target.project_number} — ` : ""}${target.name ?? "Untitled"}`
      : "the job"
    startTransition(async () => {
      try {
        const r = await bulkCopyDecisions({
          project_id: projectId,
          ids: selectedIds,
          target_project_id: targetProjectId,
        })
        if (r.ok === 0 && r.skipped.length > 0) {
          toast.error(`Nothing copied: ${r.skipped[0].reason}`)
          return
        }
        if (r.skipped.length > 0) {
          toast.warning(
            `${r.ok} copied to ${targetLabel}, ${r.skipped.length} skipped (${r.skipped[0].reason})`
          )
        } else {
          toast.success(`${r.ok} copied to ${targetLabel} (as drafts)`)
        }
        onClear()
        router.refresh()
      } catch (e) {
        toastActionError(e, "Copy failed")
      }
    })
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 w-[min(560px,calc(100vw-1rem))]">
      <div className="bg-foreground text-surface rounded-lg shadow-2xl border border-foreground/30 px-3 py-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {selectedIds.length} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="text-surface/60 hover:text-surface p-1 cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="h-5 w-px bg-surface/20 mx-1" />
        <Copy className="h-3.5 w-3.5 text-surface/80" />
        <SearchableSelect
          value={targetProjectId}
          onChange={setTargetProjectId}
          options={projects.map((p) => ({
            value: p.id,
            label: `${p.project_number != null ? `${p.project_number} — ` : ""}${p.name ?? "Untitled"}`,
          }))}
          placeholder="(no other jobs)"
          clearable={false}
          disabled={projects.length === 0}
          className="w-56 text-foreground"
          ariaLabel="Job to copy into"
        />
        <Button
          size="sm"
          variant="primary"
          onClick={runCopy}
          disabled={pending || projects.length === 0}
        >
          {pending ? "Copying…" : "Copy to job"}
        </Button>
      </div>
    </div>
  )
}

/**
 * Staff editor for the org-wide disclaimer appended to every change order and
 * selection the client views (rendered at the bottom of the decision drawer's
 * client view). Collapsed by default; the text is global, not per-project.
 */
function DisclaimerEditor({ initial }: { initial: string | null }) {
  const [saved, setSaved] = useState(initial ?? "")
  const [draft, setDraft] = useState(initial ?? "")
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()

  function save() {
    startTransition(async () => {
      const r = await saveDecisionDisclaimer({ text: draft })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setSaved(draft.trim())
      setEditing(false)
      toast.success(
        draft.trim() ? "Disclaimer saved" : "Disclaimer cleared"
      )
    })
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Client disclaimer
          </div>
          {!editing && (
            <p className="mt-1 text-xs text-muted whitespace-pre-wrap">
              {saved ||
                "No disclaimer set. Text added here appears at the bottom of every change order and selection when the client views it (all jobs)."}
            </p>
          )}
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDraft(saved)
              setEditing(true)
            }}
          >
            <Pencil className="h-3 w-3" /> {saved ? "Edit" : "Add"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="e.g. Prices are valid through the due date shown. Approved change orders and selections are added to the contract total…"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <span className="text-[11px] text-muted ml-auto">
              Shown to clients on every change order & selection, across all
              jobs.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Builds and downloads a three-sheet .xlsx with everything about this
 * project's change orders and selections: the decisions themselves, every
 * selection choice, and every cost line item. Runs entirely client-side from
 * the data the page already loaded (staff-only — cost items are RLS-empty for
 * anyone else, and the button only renders for staff).
 */
function exportDecisionsXlsx(data: DecisionsData) {
  const profileName = (id: string | null) =>
    id
      ? (data.profiles.find((p) => p.id === id)?.full_name ?? "Unknown")
      : ""
  const costCodeLabel = (id: string | null) => {
    if (!id) return ""
    const c = data.cost_codes.find((x) => x.id === id)
    return c ? `${c.code} ${c.name}` : ""
  }
  const kindLabel = (k: Enums<"decision_kind">) =>
    k === "change_order" ? "Change order" : "Selection"
  const num = (v: unknown): number | null =>
    v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)

  const byId = new Map(data.decisions.map((d) => [d.id, d]))
  const choiceTitle = (choiceId: string | null) =>
    choiceId
      ? (data.choices.find((c) => c.id === choiceId)?.title ?? "")
      : ""

  const decisionsRows: XlsxCell[][] = [
    [
      "Number",
      "Type",
      "Title",
      "Status",
      "Due date",
      "Cost delta",
      "Markup %",
      "Delay (days)",
      "Delay cost/day",
      "Allowance",
      "Selected choice",
      "Approved at",
      "Approved by",
      "Created at",
      "Description",
    ],
    ...data.decisions.map((d): XlsxCell[] => [
      d.number,
      kindLabel(d.kind),
      d.title,
      d.status,
      d.due_date,
      num(d.cost_delta),
      num(d.markup_percent),
      num(d.delay_days),
      num(d.delay_cost_per_day),
      num(d.allowance_amount),
      choiceTitle(d.selected_choice_id),
      d.approved_at ? formatDate(d.approved_at) : null,
      profileName(d.approved_by_client_id),
      formatDate(d.created_at),
      d.description,
    ]),
  ]

  const choicesRows: XlsxCell[][] = [
    ["Decision #", "Decision", "Choice", "Description", "Price", "Selected"],
    ...data.choices.map((c): XlsxCell[] => {
      const d = byId.get(c.decision_id)
      return [
        d?.number ?? null,
        d?.title ?? "",
        c.title,
        c.description,
        num(c.price_delta),
        d?.selected_choice_id === c.id ? "yes" : "",
      ]
    }),
  ]

  const lineItemsRows: XlsxCell[][] = [
    [
      "Decision #",
      "Decision",
      "Choice",
      "Cost code",
      "Description",
      "Qty",
      "Unit",
      "Unit cost",
      "Line total",
      "Catalog code",
    ],
    ...data.cost_items.map((ci): XlsxCell[] => {
      const d = byId.get(ci.decision_id)
      const qty = num(ci.quantity) ?? 0
      const unitCost = num(ci.unit_cost) ?? 0
      return [
        d?.number ?? null,
        d?.title ?? "",
        choiceTitle(ci.choice_id),
        costCodeLabel(ci.cost_code_id),
        ci.description,
        qty,
        ci.unit,
        unitCost,
        Math.round(qty * unitCost * 100) / 100,
        ci.catalog_item_code,
      ]
    }),
  ]

  const bytes = makeXlsx([
    { name: "Decisions", rows: decisionsRows },
    { name: "Choices", rows: choicesRows },
    { name: "Line items", rows: lineItemsRows },
  ])
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `decisions-${new Date().toISOString().slice(0, 10)}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
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

// Click-to-sort column heading. aria-sort lives on the th; the whole label
// is a real button for keyboard access. Inactive columns show a muted
// both-ways chevron so sortability is discoverable.
function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
  align,
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; dir: "asc" | "desc" }
  onSort: (key: SortKey) => void
  className?: string
  align?: "left" | "right"
}) {
  const active = sort.key === sortKey
  return (
    <th
      className={cn(
        "font-medium px-2 sm:px-4 py-2.5",
        align === "right" ? "text-right" : "text-left",
        className
      )}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase cursor-pointer hover:text-foreground",
          align === "right" && "justify-end",
          active && "text-foreground"
        )}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
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
  linkedTo,
}: {
  due: string | null
  status: Enums<"decision_status">
  linkedTo?: string | null
}) {
  // Marker for a due date that follows a schedule item — it moves when the
  // schedule does.
  const linkIcon = linkedTo ? (
    <span title={`Follows ${linkedTo}`}>
      <CalendarClock className="inline h-3 w-3 ml-1 text-brand-500 align-[-2px]" />
    </span>
  ) : null
  if (!due) return <span className="text-muted">—{linkIcon}</span>
  const isOpen = status === "draft" || status === "pending_client"
  const overdue = isOpen && due < new Date().toISOString().slice(0, 10)
  return (
    <span className={overdue ? "text-danger font-medium" : "text-foreground"}>
      {formatDate(due)}
      {linkIcon}
    </span>
  )
}

export function dateOrNow(value: string | null | undefined) {
  return value ? formatDate(value) : formatDate(new Date())
}
