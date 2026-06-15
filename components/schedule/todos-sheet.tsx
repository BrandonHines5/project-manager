"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { CalendarDays } from "lucide-react"
import { cn } from "@/lib/utils"
import { assigneeNamesFor } from "./helpers"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import type { Tables, Enums } from "@/lib/db/types"
import { updateScheduleItemFields } from "@/app/actions/schedule"

type StatusFilter = "all" | "open" | "complete"

// Editable spreadsheet-style grid for fast multi-row to-do edits. Title, due
// date, status and priority are editable inline; assignees and checklists are
// left to the per-to-do dialog (the pencil button) since they're relational.
export function TodosSheet({
  data,
  onEdit,
  onAddTodo,
}: {
  data: ScheduleData
  onEdit: (id: string) => void
  onAddTodo: () => void
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open")

  const todos = useMemo(() => {
    let list = data.items.filter(
      (i) => i.kind === "todo" && !i.recurrence_parent_id
    )
    if (statusFilter === "open") {
      list = list.filter((t) => t.status !== "complete")
    } else if (statusFilter === "complete") {
      list = list.filter((t) => t.status === "complete")
    }
    // Earliest due first, nulls last, then by creation for stable ordering.
    return [...list].sort((a, b) => {
      if (a.due_date == null && b.due_date == null)
        return a.created_at.localeCompare(b.created_at)
      if (a.due_date == null) return 1
      if (b.due_date == null) return -1
      return a.due_date.localeCompare(b.due_date)
    })
  }, [data.items, statusFilter])

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <label className="text-xs">
          <span className="block text-muted uppercase tracking-wide mb-0.5">
            Status
          </span>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="open">Open</option>
            <option value="all">All</option>
            <option value="complete">Complete</option>
          </Select>
        </label>
        <Button size="sm" onClick={onAddTodo}>
          <Plus className="h-3.5 w-3.5" /> To-do
        </Button>
      </div>

      {todos.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-10 w-10" />}
          title="No to-dos"
          description="Add a to-do, or change the status filter."
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-background/60 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left font-medium px-3 py-2 min-w-[220px]">
                  To-do
                </th>
                <th className="text-left font-medium px-3 py-2 w-[150px]">Due</th>
                <th className="text-left font-medium px-3 py-2 w-[140px]">
                  Status
                </th>
                <th className="text-left font-medium px-3 py-2 w-[130px]">
                  Priority
                </th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">
                  Assignees
                </th>
                <th className="px-3 py-2 w-[44px]" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {todos.map((t) => (
                <SheetRow key={t.id} item={t} data={data} onEdit={onEdit} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Edit cells directly — changes save automatically. Use the pencil for
        assignees, checklists and attachments.
      </p>
    </div>
  )
}

function SheetRow({
  item,
  data,
  onEdit,
}: {
  item: Tables<"schedule_items">
  data: ScheduleData
  onEdit: (id: string) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [title, setTitle] = useState(item.title)
  const [dueDate, setDueDate] = useState(item.due_date ?? "")
  const [status, setStatus] = useState<Enums<"schedule_item_status">>(item.status)
  const [priority, setPriority] = useState<Enums<"todo_priority"> | "">(
    item.priority ?? ""
  )
  const assignees = assigneeNamesFor(item.id, data)

  function save(fields: Parameters<typeof updateScheduleItemFields>[0]) {
    startTransition(async () => {
      try {
        await updateScheduleItemFields(fields)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  return (
    <tr className={cn("hover:bg-background/60", pending && "opacity-60")}>
      <td className="px-2 py-1 align-top">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const next = title.trim()
            if (next && next !== item.title) {
              save({ id: item.id, project_id: item.project_id, title: next })
            } else if (!next) {
              setTitle(item.title) // don't allow clearing the title
            }
          }}
          className={cn(
            "border-transparent hover:border-border-strong focus:border-brand-500",
            status === "complete" && "line-through text-muted"
          )}
          aria-label="To-do title"
        />
      </td>
      <td className="px-2 py-1 align-top">
        <Input
          type="date"
          value={dueDate}
          onChange={(e) => {
            const v = e.target.value
            setDueDate(v)
            save({
              id: item.id,
              project_id: item.project_id,
              due_date: v === "" ? null : v,
            })
          }}
          className="border-transparent hover:border-border-strong focus:border-brand-500"
          aria-label="Due date"
        />
      </td>
      <td className="px-2 py-1 align-top">
        <Select
          value={status}
          onChange={(e) => {
            const v = e.target.value as Enums<"schedule_item_status">
            setStatus(v)
            save({ id: item.id, project_id: item.project_id, status: v })
          }}
          className="border-transparent hover:border-border-strong focus:border-brand-500"
          aria-label="Status"
        >
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="complete">Complete</option>
          <option value="delayed">Delayed</option>
        </Select>
      </td>
      <td className="px-2 py-1 align-top">
        <Select
          value={priority}
          onChange={(e) => {
            const v = e.target.value as Enums<"todo_priority"> | ""
            setPriority(v)
            save({
              id: item.id,
              project_id: item.project_id,
              priority: v === "" ? null : v,
            })
          }}
          className="border-transparent hover:border-border-strong focus:border-brand-500"
          aria-label="Priority"
        >
          <option value="">—</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
      </td>
      <td className="px-3 py-1 align-middle hidden md:table-cell text-xs text-muted">
        {assignees.length > 0 ? (
          <span className="line-clamp-1" title={assignees.join(", ")}>
            {assignees.join(", ")}
          </span>
        ) : (
          <span className="text-muted/60">—</span>
        )}
      </td>
      <td className="px-2 py-1 align-middle text-right">
        <button
          type="button"
          onClick={() => onEdit(item.id)}
          className="text-muted hover:text-foreground p-1 cursor-pointer inline-flex"
          title="Open full editor"
          aria-label="Open full editor"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}
