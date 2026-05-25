"use client"

import { useState } from "react"
import {
  ChevronRight,
  CheckCircle2,
  Circle,
  Plus,
  CalendarDays,
  Repeat,
  AlertTriangle,
} from "lucide-react"
import { cn, formatDateRange, formatDate } from "@/lib/utils"
import { AvatarStack } from "@/components/ui/avatar"
import { EmptyState } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "./status-badge"
import {
  assigneeNamesFor,
  checklistFor,
  childItemsOf,
  delaysFor,
} from "./helpers"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import type { Tables } from "@/lib/db/types"

export function ScheduleListView({
  data,
  onEdit,
  onAddTodo,
}: {
  data: ScheduleData
  onEdit: (id: string) => void
  onAddTodo: (parentId?: string) => void
}) {
  const workItems = data.items
    .filter((i) => i.kind === "work" && !i.recurrence_parent_id)
    .sort((a, b) => {
      const aDate = a.start_date ?? "9999"
      const bDate = b.start_date ?? "9999"
      return aDate.localeCompare(bDate)
    })

  const unlinkedTodos = data.items.filter(
    (i) => i.kind === "todo" && !i.parent_id && !i.recurrence_parent_id
  )

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
      {workItems.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium">
            Work items
          </div>
          <ul className="divide-y divide-border">
            {workItems.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                data={data}
                onEdit={onEdit}
                onAddTodo={onAddTodo}
              />
            ))}
          </ul>
        </div>
      )}

      {unlinkedTodos.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium flex items-center justify-between">
            <span>Unlinked to-dos</span>
            <button
              onClick={() => onAddTodo(undefined)}
              className="text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
            >
              <Plus className="h-3 w-3" /> Add to-do
            </button>
          </div>
          <ul className="divide-y divide-border">
            {unlinkedTodos.map((todo) => (
              <TodoRow
                key={todo.id}
                item={todo}
                data={data}
                onEdit={onEdit}
                indent={false}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WorkItemRow({
  item,
  data,
  onEdit,
  onAddTodo,
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
  onAddTodo: (parentId?: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const children = childItemsOf(item.id, data.items)
  const assignees = assigneeNamesFor(item.id, data)
  const delays = delaysFor(item.id, data.delays)

  return (
    <li>
      <div
        className="px-4 py-3 hover:bg-background/40 cursor-pointer transition-colors group"
        onClick={() => onEdit(item.id)}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
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
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-foreground">
                {item.title}
              </h3>
              <StatusBadge status={item.status} />
              {delays.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                  <AlertTriangle className="h-3 w-3" />
                  {delays.reduce((sum, d) => sum + d.delay_days, 0)}d delayed
                </span>
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
            {assignees.length > 0 && (
              <AvatarStack names={assignees} size="sm" />
            )}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="bg-background/30 border-t border-border/60">
          <ul className="divide-y divide-border/60">
            {children.map((c) => (
              <TodoRow
                key={c.id}
                item={c}
                data={data}
                onEdit={onEdit}
                indent={true}
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
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
  indent: boolean
}) {
  const assignees = assigneeNamesFor(item.id, data)
  const checklist = checklistFor(item.id, data.checklist)
  const done = checklist.filter((c) => c.is_done).length
  const isRecurring = !!item.recurrence_rule

  return (
    <li
      className={cn(
        "px-4 py-2.5 hover:bg-background/60 cursor-pointer transition-colors flex items-start gap-3",
        indent && "pl-12"
      )}
      onClick={() => onEdit(item.id)}
    >
      <div className="mt-0.5">
        {item.status === "complete" ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <Circle className="h-4 w-4 text-muted" />
        )}
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
          {item.status === "delayed" && <StatusBadge status="delayed" />}
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
        </div>
      </div>
      {assignees.length > 0 && <AvatarStack names={assignees} size="xs" />}
    </li>
  )
}
