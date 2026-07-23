"use client"

import { useMemo, useState, useTransition } from "react"
import { toastActionError } from "@/lib/action-error"
import {
  CalendarDays,
  Plus,
  Paperclip,
  Repeat,
  CheckCircle2,
  Circle,
} from "lucide-react"
import { cn, formatDate, roleLabel } from "@/lib/utils"
import { AssigneeChips } from "./assignee-chips"
import { EmptyState } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/input"
import { StatusBadge } from "./status-badge"
import { PriorityBadge } from "./priority-badge"
import { assigneeNamesFor, checklistFor } from "./helpers"
import { isLateScheduleItem } from "@/lib/schedule/late"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import type { Tables, Enums } from "@/lib/db/types"
import { setItemStatus } from "@/app/actions/schedule"

type Sort = "due_asc" | "due_desc" | "priority" | "created"
type StatusFilter = "all" | "open" | "complete" | "delayed"
type PriorityFilter = "all" | "high" | "medium" | "low" | "none"

const PRIORITY_RANK: Record<Enums<"todo_priority">, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

export function TodosView({
  data,
  hideComplete,
  onEdit,
  onAddTodo,
}: {
  data: ScheduleData
  hideComplete: boolean
  onEdit: (id: string) => void
  onAddTodo: () => void
}) {
  const [sort, setSort] = useState<Sort>("due_asc")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open")
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all")
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all")

  const todos = useMemo(() => {
    let list = data.items.filter(
      (i) => i.kind === "todo" && !i.recurrence_parent_id
    )

    // Schedule-wide "hide complete" wins over the local status filter.
    if (hideComplete) {
      list = list.filter((t) => t.status !== "complete")
    }

    // Status filter
    if (statusFilter === "open") {
      list = list.filter((t) => t.status !== "complete")
    } else if (statusFilter === "complete") {
      list = list.filter((t) => t.status === "complete")
    } else if (statusFilter === "delayed") {
      list = list.filter((t) => t.status === "delayed")
    }

    // Priority filter
    if (priorityFilter !== "all") {
      if (priorityFilter === "none") {
        list = list.filter((t) => !t.priority)
      } else {
        list = list.filter((t) => t.priority === priorityFilter)
      }
    }

    // Assignee filter: any assignment for this profile/company that matches.
    // Role assignments count too — an item assigned to "Internal Operations
    // Manager" belongs to whoever fills that role on this project, so
    // filtering by that person surfaces it alongside their direct items.
    if (assigneeFilter !== "all") {
      const filledRoleIds = new Set(
        data.roleMembers
          .filter(
            (m) =>
              m.profile_id === assigneeFilter ||
              m.company_id === assigneeFilter
          )
          .map((m) => m.role_id)
      )
      const assignedItemIds = new Set(
        data.assignments.map((a) => a.schedule_item_id)
      )
      const matchingItemIds = new Set(
        data.assignments
          .filter(
            (a) =>
              a.profile_id === assigneeFilter ||
              a.company_id === assigneeFilter ||
              (a.role_id != null && filledRoleIds.has(a.role_id))
          )
          .map((a) => a.schedule_item_id)
      )
      list = list.filter((t) => {
        if (matchingItemIds.has(t.id)) return true
        // A to-do with no assignments of its own displays its parent work
        // item's assignees (the dimmed "inherited" chips) — match through
        // the parent so the filter agrees with what the row shows.
        if (t.parent_id && !assignedItemIds.has(t.id)) {
          return matchingItemIds.has(t.parent_id)
        }
        return false
      })
    }

    // Sort
    const compareDates = (
      a: string | null | undefined,
      b: string | null | undefined,
      dir: 1 | -1
    ) => {
      if (a == null && b == null) return 0
      if (a == null) return 1 // nulls always last
      if (b == null) return -1
      return dir * a.localeCompare(b)
    }

    if (sort === "due_asc") {
      list = [...list].sort((a, b) => compareDates(a.due_date, b.due_date, 1))
    } else if (sort === "due_desc") {
      list = [...list].sort((a, b) => compareDates(a.due_date, b.due_date, -1))
    } else if (sort === "priority") {
      list = [...list].sort((a, b) => {
        const ar = a.priority ? PRIORITY_RANK[a.priority] : 99
        const br = b.priority ? PRIORITY_RANK[b.priority] : 99
        if (ar !== br) return ar - br
        return compareDates(a.due_date, b.due_date, 1)
      })
    } else if (sort === "created") {
      list = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
    }

    return list
  }, [
    data.items,
    data.assignments,
    data.roleMembers,
    sort,
    statusFilter,
    priorityFilter,
    assigneeFilter,
    hideComplete,
  ])

  const assigneeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = []
    for (const p of data.profiles)
      opts.push({
        value: p.id,
        label: `${p.full_name || p.email} · ${roleLabel(p.role)}`,
      })
    for (const c of data.companies)
      if (c.type !== "client")
        opts.push({ value: c.id, label: `${c.name} (company)` })
    return opts
  }, [data.profiles, data.companies])

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-end gap-2 flex-wrap">
          <FilterField label="Sort by">
            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="due_asc">Due date · earliest first</option>
              <option value="due_desc">Due date · latest first</option>
              <option value="priority">Priority</option>
              <option value="created">Recently created</option>
            </Select>
          </FilterField>
          <FilterField label="Status">
            <Select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as StatusFilter)
              }
            >
              <option value="open">Open</option>
              <option value="all">All</option>
              <option value="complete">Complete</option>
              <option value="delayed">Delayed</option>
            </Select>
          </FilterField>
          <FilterField label="Priority">
            <Select
              value={priorityFilter}
              onChange={(e) =>
                setPriorityFilter(e.target.value as PriorityFilter)
              }
            >
              <option value="all">All</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="none">No priority</option>
            </Select>
          </FilterField>
          <FilterField label="Assignee">
            <Select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
            >
              <option value="all">Anyone</option>
              {assigneeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FilterField>
        </div>
        <Button size="sm" onClick={onAddTodo}>
          <Plus className="h-3.5 w-3.5" /> To-do
        </Button>
      </div>

      {todos.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-10 w-10" />}
          title="No to-dos match these filters"
          description="Adjust the filters above, or add a new to-do."
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium">
            {todos.length} to-do{todos.length === 1 ? "" : "s"}
          </div>
          <ul className="divide-y divide-border">
            {todos.map((t) => (
              <TodoRow key={t.id} item={t} data={data} onEdit={onEdit} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function TodoRow({
  item,
  data,
  onEdit,
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
}) {
  const directAssignees = assigneeNamesFor(item.id, data)
  const checklist = checklistFor(item.id, data.checklist)
  const done = checklist.filter((c) => c.is_done).length
  const isRecurring = !!item.recurrence_rule
  const attachmentCount = data.attachments.filter(
    (a) => a.schedule_item_id === item.id
  ).length
  const parent = item.parent_id
    ? data.items.find((i) => i.id === item.parent_id)
    : null
  // Fall back to the parent work item's assignees when the to-do itself
  // has none — for a to-do under a work item, the responsible party is
  // usually whoever's doing the work. The fallback set is rendered
  // dimmed so it's distinguishable from a direct assignment.
  const parentAssignees =
    directAssignees.length === 0 && parent
      ? assigneeNamesFor(parent.id, data)
      : []
  const assignees =
    directAssignees.length > 0 ? directAssignees : parentAssignees
  const inheritedAssignees = directAssignees.length === 0

  const [pending, startTransition] = useTransition()
  const isComplete = item.status === "complete"
  const isLate = isLateScheduleItem(item)
  // Same constraint as the schedule list view: only round-trip via this
  // control when the current status is one of the two binary states.
  // Otherwise toggling would erase `in_progress` / `delayed`.
  const canBinaryToggle =
    item.status === "complete" || item.status === "not_started"

  function toggleComplete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!canBinaryToggle) return
    startTransition(async () => {
      try {
        await setItemStatus({
          id: item.id,
          project_id: item.project_id,
          status: isComplete ? "not_started" : "complete",
        })
      } catch (err) {
        toastActionError(err, "Could not update status")
      }
    })
  }

  return (
    <li
      className="px-4 py-3 hover:bg-background/60 cursor-pointer transition-colors flex items-start gap-3"
      role="button"
      tabIndex={0}
      onClick={() => onEdit(item.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onEdit(item.id)
        }
      }}
    >
      <button
        type="button"
        onClick={toggleComplete}
        disabled={pending || !canBinaryToggle}
        aria-label={isComplete ? "Mark not complete" : "Mark complete"}
        className={cn(
          "mt-0.5 cursor-pointer",
          pending && "opacity-50",
          !canBinaryToggle && "cursor-default opacity-60"
        )}
      >
        {isComplete ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <Circle className="h-4 w-4 text-muted hover:text-foreground" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "text-sm",
              isLate && "text-danger",
              isComplete && "line-through text-muted"
            )}
          >
            {item.title}
          </span>
          {item.priority && <PriorityBadge priority={item.priority} />}
          {isRecurring && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-brand-700 bg-brand-100 px-1.5 py-0.5 rounded">
              <Repeat className="h-2.5 w-2.5" /> recurring
            </span>
          )}
          {item.status !== "not_started" && item.status !== "complete" && (
            <StatusBadge status={item.status} />
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted">
          {item.due_date && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                isLate && "text-danger"
              )}
            >
              <CalendarDays className="h-3 w-3" /> Due {formatDate(item.due_date)}
            </span>
          )}
          {parent && <span>under <strong>{parent.title}</strong></span>}
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
      <AssigneeChips
        names={assignees}
        size="xs"
        className={cn(inheritedAssignees && "opacity-60")}
        title={
          inheritedAssignees
            ? `Inherited from parent: ${parent?.title ?? ""} — ${assignees.join(", ")}`
            : undefined
        }
      />
    </li>
  )
}

function FilterField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="text-xs">
      <span className="block text-muted uppercase tracking-wide mb-0.5">
        {label}
      </span>
      {children}
    </label>
  )
}
