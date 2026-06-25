"use client"

import { useState, useMemo } from "react"
import { Plus, List, BarChart3, CheckSquare, Table, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Tables } from "@/lib/db/types"
import { ScheduleListView } from "@/components/schedule/schedule-list-view"
import { GanttView } from "@/components/schedule/gantt-view"
import { TodosView } from "@/components/schedule/todos-view"
import { TodosSheet } from "@/components/schedule/todos-sheet"
import { ScheduleItemDialog } from "@/components/schedule/schedule-item-dialog"

export type ScheduleData = {
  project_id: string
  project_address: string | null
  items: Tables<"schedule_items">[]
  assignments: Tables<"schedule_assignments">[]
  predecessors: Tables<"schedule_predecessors">[]
  checklist: Tables<"todo_checklist_items">[]
  delays: Tables<"schedule_delays">[]
  attachments: Tables<"schedule_item_attachments">[]
  signed_urls: Record<string, string>
  profiles: Pick<Tables<"profiles">, "id" | "full_name" | "email" | "role" | "company_id">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category" | "phone">[]
  // Role catalog + this project's role → assignee map, so a schedule item
  // assigned to a role resolves to "Role (Person)" for display.
  roles: Pick<Tables<"roles">, "id" | "name" | "kind">[]
  roleMembers: Pick<Tables<"project_role_members">, "role_id" | "profile_id" | "company_id">[]
}

type View = "list" | "gantt" | "todos" | "sheet"

export function ScheduleClient({ data }: { data: ScheduleData }) {
  const [view, setView] = useState<View>("list")
  // Schedule-wide toggle: hide completed items across every view. Lives here
  // so it persists as the user switches between List / To-dos / Sheet / Gantt.
  const [hideComplete, setHideComplete] = useState(false)
  const [dialogState, setDialogState] = useState<
    | { mode: "create"; kind: "work" | "todo"; parentId?: string }
    | { mode: "edit"; itemId: string }
    | null
  >(null)

  const items = data.items
  const stats = useMemo(() => {
    const work = items.filter((i) => i.kind === "work")
    const todos = items.filter((i) => i.kind === "todo")
    const open = items.filter((i) => i.status !== "complete").length
    const delayed = items.filter((i) => i.status === "delayed").length
    return { work: work.length, todos: todos.length, open, delayed }
  }, [items])

  const editItem =
    dialogState?.mode === "edit"
      ? items.find((i) => i.id === dialogState.itemId)
      : null

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-4 text-sm">
          <StatChip label="Work items" value={stats.work} />
          <StatChip label="To-dos" value={stats.todos} />
          <StatChip label="Open" value={stats.open} />
          <StatChip
            label="Delayed"
            value={stats.delayed}
            tone={stats.delayed > 0 ? "danger" : "muted"}
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setHideComplete((v) => !v)}
            title={
              hideComplete
                ? "Show completed items across the schedule"
                : "Hide completed items across the schedule"
            }
          >
            {hideComplete ? (
              <>
                <Eye className="h-3.5 w-3.5" /> Show complete
              </>
            ) : (
              <>
                <EyeOff className="h-3.5 w-3.5" /> Hide complete
              </>
            )}
          </Button>
          <div className="inline-flex rounded-md border border-border-strong bg-surface p-0.5">
            <button
              onClick={() => setView("list")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded inline-flex items-center gap-1.5 cursor-pointer",
                view === "list"
                  ? "bg-brand-500 text-white"
                  : "text-muted hover:text-foreground"
              )}
            >
              <List className="h-3.5 w-3.5" /> List
            </button>
            <button
              onClick={() => setView("todos")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded inline-flex items-center gap-1.5 cursor-pointer",
                view === "todos"
                  ? "bg-brand-500 text-white"
                  : "text-muted hover:text-foreground"
              )}
            >
              <CheckSquare className="h-3.5 w-3.5" /> To-dos
            </button>
            <button
              onClick={() => setView("sheet")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded inline-flex items-center gap-1.5 cursor-pointer",
                view === "sheet"
                  ? "bg-brand-500 text-white"
                  : "text-muted hover:text-foreground"
              )}
            >
              <Table className="h-3.5 w-3.5" /> Sheet
            </button>
            <button
              onClick={() => setView("gantt")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded inline-flex items-center gap-1.5 cursor-pointer",
                view === "gantt"
                  ? "bg-brand-500 text-white"
                  : "text-muted hover:text-foreground"
              )}
            >
              <BarChart3 className="h-3.5 w-3.5" /> Gantt
            </button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setDialogState({ mode: "create", kind: "todo" })
            }
          >
            <Plus className="h-3.5 w-3.5" /> To-do
          </Button>
          <Button
            size="sm"
            onClick={() =>
              setDialogState({ mode: "create", kind: "work" })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Work item
          </Button>
        </div>
      </div>

      {view === "list" && (
        <ScheduleListView
          data={data}
          projectId={data.project_id}
          hideComplete={hideComplete}
          onEdit={(id) => setDialogState({ mode: "edit", itemId: id })}
          onAddTodo={(parentId) =>
            setDialogState({ mode: "create", kind: "todo", parentId })
          }
        />
      )}
      {view === "todos" && (
        <TodosView
          data={data}
          hideComplete={hideComplete}
          onEdit={(id) => setDialogState({ mode: "edit", itemId: id })}
          onAddTodo={() => setDialogState({ mode: "create", kind: "todo" })}
        />
      )}
      {view === "sheet" && (
        <TodosSheet
          data={data}
          hideComplete={hideComplete}
          onEdit={(id) => setDialogState({ mode: "edit", itemId: id })}
          onAddTodo={() => setDialogState({ mode: "create", kind: "todo" })}
        />
      )}
      {view === "gantt" && (
        <GanttView
          data={data}
          hideComplete={hideComplete}
          onEdit={(id) => setDialogState({ mode: "edit", itemId: id })}
        />
      )}

      {dialogState && (
        <ScheduleItemDialog
          open={true}
          onClose={() => setDialogState(null)}
          data={data}
          mode={dialogState.mode === "edit" ? "edit" : "create"}
          item={editItem ?? undefined}
          defaultKind={
            dialogState.mode === "create" ? dialogState.kind : undefined
          }
          defaultParentId={
            dialogState.mode === "create" ? dialogState.parentId : undefined
          }
        />
      )}
    </div>
  )
}

function StatChip({
  label,
  value,
  tone = "muted",
}: {
  label: string
  value: number
  tone?: "muted" | "danger"
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "danger" && value > 0 && "text-danger"
        )}
      >
        {value}
      </span>
    </div>
  )
}
