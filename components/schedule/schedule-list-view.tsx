"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import {
  ChevronRight,
  CheckCircle2,
  Circle,
  Plus,
  CalendarDays,
  Repeat,
  AlertTriangle,
  ChevronsDownUp,
  ChevronsUpDown,
  Paperclip,
  Zap,
  Flag,
  Search,
  X,
} from "lucide-react"
import { cn, formatDateRange, formatDate } from "@/lib/utils"
import { AssigneeChips } from "./assignee-chips"
import { EmptyState } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "./status-badge"
import { PriorityBadge } from "./priority-badge"
import { BulkActionsBar } from "./bulk-actions-bar"
import {
  assigneeNamesFor,
  checklistFor,
  childItemsOf,
  delaysFor,
  resolveRoleLabel,
} from "./helpers"
import { setItemStatus } from "@/app/actions/schedule"
import { computeCriticalPath } from "@/lib/schedule/scheduling"
import { isNegatedTag, tagLabel } from "@/lib/template-tags"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import type { Tables } from "@/lib/db/types"

// Template-tag chips for a schedule row. Only rendered on template projects
// (see WorkItemRow / TodoRow) — the tags are inert once a template is copied
// into a real job, so they stay hidden there. A negated tag ("!walkout")
// reads as "not walkout".
function TemplateTagBadges({ tags }: { tags: string[] | null | undefined }) {
  if (!tags || tags.length === 0) return null
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center text-[11px] text-purple-700 bg-purple-50 border border-purple-500/30 px-1.5 py-0.5 rounded"
          title="Template tag — controls whether this item is copied when creating a job from this template"
        >
          {isNegatedTag(tag) ? `not ${tagLabel(tag)}` : tagLabel(tag)}
        </span>
      ))}
    </>
  )
}

export function ScheduleListView({
  data,
  projectId,
  hideComplete,
  onEdit,
  onAddTodo,
}: {
  data: ScheduleData
  projectId: string
  hideComplete: boolean
  onEdit: (id: string) => void
  onAddTodo: (parentId?: string) => void
}) {
  const workItems = useMemo(
    () =>
      data.items
        .filter((i) => i.kind === "work" && !i.recurrence_parent_id)
        .sort((a, b) => {
          const aDate = a.start_date ?? "9999"
          const bDate = b.start_date ?? "9999"
          return aDate.localeCompare(bDate)
        }),
    [data.items]
  )

  const unlinkedTodos = data.items.filter(
    (i) => i.kind === "todo" && !i.parent_id && !i.recurrence_parent_id
  )

  // The two soonest critical-path work items that aren't done yet — surfaced
  // above the list so the PM sees what actually drives the finish date.
  // computeCriticalPath already excludes to-dos, undated items, and anything
  // flagged off the critical path. workItems is sorted by start_date, so
  // taking the first two incomplete-critical entries gives the next two.
  const nextCriticalItems = useMemo(() => {
    const criticalIds = computeCriticalPath(data.items, data.predecessors)
    return workItems
      .filter((w) => criticalIds.has(w.id) && w.status !== "complete")
      .slice(0, 2)
  }, [data.items, data.predecessors, workItems])

  // "Hide complete" (driven by the schedule-wide toggle) hides finished work
  // items and to-dos to declutter the list. A completed work item stays
  // visible while it still has open to-dos under it, so the remaining tasks
  // aren't hidden along with their parent.
  const visibleWorkItems = useMemo(() => {
    if (!hideComplete) return workItems
    return workItems.filter(
      (w) =>
        w.status !== "complete" ||
        childItemsOf(w.id, data.items).some((c) => c.status !== "complete")
    )
  }, [workItems, hideComplete, data.items])
  const visibleUnlinkedTodos = hideComplete
    ? unlinkedTodos.filter((t) => t.status !== "complete")
    : unlinkedTodos

  // Keyword filter for the schedule list (the field just above it).
  // Case-insensitive substring match on work item AND to-do titles: a work
  // item stays visible when its own title matches or any of its child
  // to-dos match (the rows then show just the matching to-dos). Unlinked
  // to-dos filter by their own title. The critical-path summary is untouched.
  const [workSearch, setWorkSearch] = useState("")
  const workQuery = workSearch.trim().toLowerCase()
  const searchedWorkItems = useMemo(
    () =>
      workQuery
        ? visibleWorkItems.filter(
            (w) =>
              w.title.toLowerCase().includes(workQuery) ||
              childItemsOf(w.id, data.items).some((c) =>
                c.title.toLowerCase().includes(workQuery)
              )
          )
        : visibleWorkItems,
    [visibleWorkItems, workQuery, data.items]
  )
  const searchedUnlinkedTodos = workQuery
    ? visibleUnlinkedTodos.filter((t) =>
        t.title.toLowerCase().includes(workQuery)
      )
    : visibleUnlinkedTodos

  // Expansion state lifted out of WorkItemRow so the Expand/Collapse all
  // buttons can drive every row in one click. Default: every work item is
  // expanded (matches the previous per-row default).
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const allCollapsed =
    workItems.length > 0 && workItems.every((w) => collapsedIds.has(w.id))

  // Bulk selection. Keyed by schedule_item.id; spans work items, their
  // child to-dos, and unlinked to-dos so a PM can select e.g. "all framing
  // tasks across both subsections" and shift them together. Clearing selects
  // nothing and dismisses the bulk action bar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const clearSelection = () => setSelectedIds(new Set())

  function setExpandedFor(id: string, expanded: boolean) {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (expanded) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function expandAll() {
    setCollapsedIds(new Set())
  }

  function collapseAll() {
    setCollapsedIds(new Set(workItems.map((w) => w.id)))
  }

  if (workItems.length === 0 && unlinkedTodos.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays className="h-10 w-10" />}
        title="No schedule items yet"
        description="Add a work item to start building the schedule."
        action={
          <Button onClick={() => onAddTodo(undefined)} variant="secondary">
            Or add a standalone to-do
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Critical-path summary */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted font-medium">
          <Zap className="h-3.5 w-3.5 text-danger" />
          Next 2 Critical Path Items
        </div>
        {nextCriticalItems.length > 0 ? (
          <ol className="mt-1.5 space-y-1">
            {nextCriticalItems.map((it, i) => (
              <li key={it.id} className="flex items-baseline gap-2 text-sm">
                <span className="text-muted tabular-nums">{i + 1}.</span>
                <button
                  type="button"
                  onClick={() => onEdit(it.id)}
                  className="text-left min-w-0 cursor-pointer hover:underline"
                >
                  <span className="font-medium text-foreground">
                    {it.title}
                  </span>
                  <span className="ml-2 text-xs text-muted">
                    {formatDateRange(it.start_date, it.end_date)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1.5 text-sm text-muted">
            No incomplete critical-path items.
          </p>
        )}
      </div>

      {hideComplete &&
        visibleWorkItems.length === 0 &&
        visibleUnlinkedTodos.length === 0 && (
          <p className="text-sm text-muted px-1">
            All items are complete. Click “Show complete” to see them.
          </p>
        )}

      {visibleWorkItems.length > 0 && (
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted pointer-events-none" />
            <input
              type="text"
              value={workSearch}
              onChange={(e) => setWorkSearch(e.target.value)}
              placeholder="Search work items & to-dos…"
              aria-label="Search work items and to-dos"
              className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            />
            {workSearch !== "" && (
              <button
                type="button"
                onClick={() => setWorkSearch("")}
                aria-label="Clear work item search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium flex items-center justify-between">
              <span>
                Work items
                {workQuery &&
                  ` · ${searchedWorkItems.length} of ${visibleWorkItems.length}`}
              </span>
              <button
                type="button"
                onClick={allCollapsed ? expandAll : collapseAll}
                className="inline-flex items-center gap-1 text-[11px] font-medium normal-case tracking-normal text-muted hover:text-foreground cursor-pointer"
                title={allCollapsed ? "Expand all work items" : "Collapse all work items"}
              >
                {allCollapsed ? (
                  <>
                    <ChevronsUpDown className="h-3.5 w-3.5" /> Expand all
                  </>
                ) : (
                  <>
                    <ChevronsDownUp className="h-3.5 w-3.5" /> Collapse all
                  </>
                )}
              </button>
            </div>
            {searchedWorkItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">
                No work items or to-dos match &ldquo;{workSearch.trim()}&rdquo;.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {searchedWorkItems.map((item) => (
                  <WorkItemRow
                    key={item.id}
                    item={item}
                    data={data}
                    onEdit={onEdit}
                    onAddTodo={onAddTodo}
                    // While searching, matches may live in collapsed rows —
                    // force-expand so they're actually visible.
                    expanded={!!workQuery || !collapsedIds.has(item.id)}
                    onToggleExpanded={(next) => setExpandedFor(item.id, next)}
                    selectedIds={selectedIds}
                    onToggleSelected={toggleSelected}
                    hideComplete={hideComplete}
                    searchQuery={workQuery}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {searchedUnlinkedTodos.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium flex items-center justify-between">
            <span>
              Unlinked to-dos
              {workQuery &&
                ` · ${searchedUnlinkedTodos.length} of ${visibleUnlinkedTodos.length}`}
            </span>
            <button
              onClick={() => onAddTodo(undefined)}
              className="text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
            >
              <Plus className="h-3 w-3" /> Add to-do
            </button>
          </div>
          <ul className="divide-y divide-border">
            {searchedUnlinkedTodos.map((todo) => (
              <TodoRow
                key={todo.id}
                item={todo}
                data={data}
                onEdit={onEdit}
                indent={false}
                selected={selectedIds.has(todo.id)}
                onToggleSelected={() => toggleSelected(todo.id)}
              />
            ))}
          </ul>
        </div>
      )}

      <BulkActionsBar
        projectId={projectId}
        selectedIds={Array.from(selectedIds)}
        baselineSet={!!data.baseline_set_at}
        hasWorkSelected={data.items.some(
          (i) => i.kind === "work" && selectedIds.has(i.id)
        )}
        profiles={data.profiles
          .filter((p) => p.role === "staff")
          .map((p) => ({
            id: p.id,
            full_name: p.full_name,
            email: p.email ?? null,
          }))
          .sort((a, b) =>
            (a.full_name || a.email || "").localeCompare(
              b.full_name || b.email || ""
            )
          )}
        roles={data.roles.map((r) => ({
          id: r.id,
          label: resolveRoleLabel(r.id, data),
        }))}
        projects={data.projects
          .filter((p) => p.id !== projectId)
          .map((p) => ({
            id: p.id,
            label: `${p.project_number != null ? `${p.project_number} — ` : ""}${p.name ?? "Untitled"}`,
          }))}
        onClear={clearSelection}
      />
    </div>
  )
}

/**
 * Tiny pre-styled checkbox for the row "select" affordance. Click is
 * stopPropagation'd so checking a row doesn't open its edit drawer.
 */
function SelectCheckbox({
  checked,
  onToggle,
  size = "md",
}: {
  checked: boolean
  onToggle: () => void
  size?: "sm" | "md"
}) {
  const dim = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Deselect" : "Select"}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "shrink-0 rounded border flex items-center justify-center cursor-pointer transition-colors",
        dim,
        checked
          ? "bg-brand-500 border-brand-500 text-white"
          : "bg-surface border-border-strong hover:border-foreground"
      )}
    >
      {checked && (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
          <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}

function CompleteCheckbox({
  item,
  size = "md",
  baselineSet = true,
}: {
  item: Tables<"schedule_items">
  size?: "sm" | "md"
  // Work items can't be completed until the project baseline is locked.
  // To-do callers can omit this — the rule never applies to them.
  baselineSet?: boolean
}) {
  const [pending, startTransition] = useTransition()
  const isComplete = item.status === "complete"
  // Only safe to round-trip via this control when the item is already in one
  // of the two binary states. For `in_progress` / `delayed`, toggling would
  // irreversibly collapse the status to `not_started` — instead we render
  // the icon read-only and the user opens the item to change status.
  const canBinaryToggle =
    item.status === "complete" || item.status === "not_started"
  const dim = size === "sm" ? "h-4 w-4" : "h-5 w-5"

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isComplete}
      aria-label={isComplete ? "Mark not complete" : "Mark complete"}
      disabled={pending || !canBinaryToggle}
      onClick={(e) => {
        e.stopPropagation()
        if (!canBinaryToggle) return
        if (item.kind === "work" && !isComplete && !baselineSet) {
          toast.error(
            "Set the schedule baseline before marking work items complete — use “Set baseline” at the top of the page."
          )
          return
        }
        startTransition(async () => {
          try {
            await setItemStatus({
              id: item.id,
              project_id: item.project_id,
              status: isComplete ? "not_started" : "complete",
            })
          } catch (e) {
            toast.error(
              e instanceof Error ? e.message : "Status update failed"
            )
          }
        })
      }}
      className={cn(
        "shrink-0 cursor-pointer transition-opacity",
        pending && "opacity-50",
        !canBinaryToggle && "cursor-default opacity-60"
      )}
      title={
        canBinaryToggle
          ? undefined
          : `Status is "${item.status.replace("_", " ")}" — open the item to change`
      }
    >
      {isComplete ? (
        <CheckCircle2 className={cn(dim, "text-success")} />
      ) : (
        <Circle className={cn(dim, "text-muted hover:text-foreground")} />
      )}
    </button>
  )
}

function WorkItemRow({
  item,
  data,
  onEdit,
  onAddTodo,
  expanded,
  onToggleExpanded,
  selectedIds,
  onToggleSelected,
  hideComplete,
  searchQuery = "",
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
  onAddTodo: (parentId?: string) => void
  expanded: boolean
  onToggleExpanded: (next: boolean) => void
  selectedIds: Set<string>
  onToggleSelected: (id: string) => void
  hideComplete: boolean
  // Active list-filter keyword (already lowercased). When this row is shown
  // only because some of its to-dos match, the rendered children narrow to
  // those matches; a title-matched row keeps all its children.
  searchQuery?: string
}) {
  const children = childItemsOf(item.id, data.items)
  // The "X/Y to-dos" count below still reflects all children; only the
  // rendered rows are filtered when hiding completed items or searching.
  const hideFiltered = hideComplete
    ? children.filter((c) => c.status !== "complete")
    : children
  const titleMatches =
    searchQuery !== "" && item.title.toLowerCase().includes(searchQuery)
  const visibleChildren =
    searchQuery !== "" && !titleMatches
      ? hideFiltered.filter((c) =>
          c.title.toLowerCase().includes(searchQuery)
        )
      : hideFiltered
  const assignees = assigneeNamesFor(item.id, data)
  const delays = delaysFor(item.id, data.delays)
  const isSelected = selectedIds.has(item.id)

  return (
    <li>
      <div
        className={cn(
          "px-4 py-3 hover:bg-background/40 cursor-pointer transition-colors group",
          isSelected && "bg-brand-50/60"
        )}
        onClick={() => onEdit(item.id)}
      >
        <div className="flex items-start gap-3">
          <div className="mt-1.5">
            <SelectCheckbox
              checked={isSelected}
              onToggle={() => onToggleSelected(item.id)}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpanded(!expanded)
            }}
            className="mt-1 text-muted hover:text-foreground p-0.5 cursor-pointer"
            aria-label="Toggle"
          >
            <ChevronRight
              className={cn(
                "h-4 w-4 transition-transform",
                expanded && "rotate-90"
              )}
            />
          </button>
          <div className="mt-0.5">
            <CompleteCheckbox
              item={item}
              baselineSet={!!data.baseline_set_at}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className={cn(
                  "text-sm font-semibold text-foreground",
                  item.status === "complete" && "line-through text-muted"
                )}
              >
                {item.title}
              </h3>
              {item.milestone && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] text-brand-600 bg-brand-50 border border-brand-500/30 px-1.5 py-0.5 rounded"
                  title="Protected milestone — defines the tracked job duration; can't be deleted"
                >
                  <Flag className="h-3 w-3" />
                  Milestone
                </span>
              )}
              <StatusBadge status={item.status} />
              {delays.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                  <AlertTriangle className="h-3 w-3" />
                  {delays.reduce((sum, d) => sum + d.delay_days, 0)}d delayed
                </span>
              )}
              {data.is_template && (
                <TemplateTagBadges tags={item.template_tags} />
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {formatDateRange(item.start_date, item.end_date)}
                {item.duration_days && ` · ${item.duration_days}d`}
              </span>
              {children.length > 0 && (
                <span>
                  {children.filter((c) => c.status === "complete").length}/
                  {children.length} to-dos
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AssigneeChips names={assignees} size="sm" />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="bg-background/30 border-t border-border/60">
          <ul className="divide-y divide-border/60">
            {visibleChildren.map((c) => (
              <TodoRow
                key={c.id}
                item={c}
                data={data}
                onEdit={onEdit}
                indent={true}
                selected={selectedIds.has(c.id)}
                onToggleSelected={() => onToggleSelected(c.id)}
              />
            ))}
            <li>
              <button
                onClick={() => onAddTodo(item.id)}
                className="w-full text-left pl-12 pr-4 py-2 text-xs text-brand-600 hover:bg-background flex items-center gap-1 cursor-pointer"
              >
                <Plus className="h-3 w-3" /> Add to-do
              </button>
            </li>
          </ul>
        </div>
      )}
    </li>
  )
}

function TodoRow({
  item,
  data,
  onEdit,
  indent,
  selected,
  onToggleSelected,
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
  indent: boolean
  selected: boolean
  onToggleSelected: () => void
}) {
  const assignees = assigneeNamesFor(item.id, data)
  const checklist = checklistFor(item.id, data.checklist)
  const done = checklist.filter((c) => c.is_done).length
  const isRecurring = !!item.recurrence_rule
  const attachmentCount = data.attachments.filter(
    (a) => a.schedule_item_id === item.id
  ).length

  return (
    <li
      className={cn(
        "px-4 py-2.5 hover:bg-background/60 cursor-pointer transition-colors flex items-start gap-3",
        indent && "pl-12",
        selected && "bg-brand-50/60"
      )}
      onClick={() => onEdit(item.id)}
    >
      <div className="mt-1">
        <SelectCheckbox
          checked={selected}
          onToggle={onToggleSelected}
          size="sm"
        />
      </div>
      <div className="mt-0.5">
        <CompleteCheckbox item={item} size="sm" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "text-sm",
              item.status === "complete" && "line-through text-muted"
            )}
          >
            {item.title}
          </span>
          {isRecurring && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-brand-700 bg-brand-100 px-1.5 py-0.5 rounded">
              <Repeat className="h-2.5 w-2.5" /> recurring
            </span>
          )}
          {item.priority && <PriorityBadge priority={item.priority} />}
          {item.status === "delayed" && <StatusBadge status="delayed" />}
          {data.is_template && (
            <TemplateTagBadges tags={item.template_tags} />
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted">
          {item.due_date && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" /> Due {formatDate(item.due_date)}
            </span>
          )}
          {checklist.length > 0 && (
            <span>
              {done}/{checklist.length} checked
            </span>
          )}
          {attachmentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Paperclip className="h-3 w-3" /> {attachmentCount}
            </span>
          )}
        </div>
      </div>
      <AssigneeChips names={assignees} size="xs" />
    </li>
  )
}
