import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { formatDate, todayISO } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Warranty — Hines Homes" }

const STATUS_TONE: Record<
  Enums<"schedule_item_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
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

export default async function WarrantyPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  // Projects currently in the warranty phase. RLS still applies.
  const { data: projects, error: projErr } = await supabase
    .from("projects")
    .select("id, project_number, name, address")
    .eq("status", "warranty")
    .order("project_number")
  if (projErr) throw new Error(projErr.message)

  const projectIds = (projects ?? []).map((p) => p.id)

  type WarrantyTodo = {
    id: string
    project_id: string
    title: string
    due_date: string | null
    status: Enums<"schedule_item_status">
  }

  // Open to-dos on those projects ARE the warranty punch list. "Open" = any
  // to-do that isn't complete.
  let todos: WarrantyTodo[] = []
  if (projectIds.length) {
    const { data, error } = await supabase
      .from("schedule_items")
      .select("id, project_id, title, due_date, status")
      .in("project_id", projectIds)
      .eq("kind", "todo")
      .neq("status", "complete")
    if (error) throw new Error(error.message)
    todos = data ?? []
  }

  const today = todayISO()
  const byProject = new Map<string, WarrantyTodo[]>()
  for (const t of todos) {
    const arr = byProject.get(t.project_id) ?? []
    arr.push(t)
    byProject.set(t.project_id, arr)
  }
  // Surface the earliest-due open item first within each project.
  for (const arr of byProject.values()) {
    arr.sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return a.due_date.localeCompare(b.due_date)
    })
  }

  const totalOpen = todos.length

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-5">
      <div className="mb-5">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-600" />
          Warranty
        </h1>
        <p className="text-sm text-muted mt-0.5">
          Projects in the warranty phase and their open warranty to-dos.
        </p>
      </div>

      {(projects ?? []).length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-8 w-8" />}
          title="No projects in warranty"
          description="Move a project to the Warranty status from its edit dialog to track open warranty items here."
        />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-6 text-sm">
            <Stat label="In warranty" value={projects!.length} />
            <Stat label="Open to-dos" value={totalOpen} />
          </div>

          <div className="space-y-5">
            {projects!.map((p) => {
              const items = byProject.get(p.id) ?? []
              return (
                <section
                  key={p.id}
                  className="bg-surface border border-border rounded-lg overflow-hidden"
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
                    <Link
                      href={`/projects/${p.id}/schedule`}
                      className="min-w-0 group"
                    >
                      <div className="font-mono text-[11px] text-muted">
                        {p.project_number}
                      </div>
                      <div className="font-medium text-sm group-hover:text-brand-600 truncate">
                        {p.name}
                      </div>
                    </Link>
                    <Badge tone={items.length ? "warning" : "success"}>
                      {items.length} open
                    </Badge>
                  </div>

                  {items.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted">
                      No open warranty to-dos. 🎉
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {items.map((t) => {
                        const overdue =
                          !!t.due_date &&
                          t.due_date < today &&
                          t.status !== "complete"
                        return (
                          <li
                            key={t.id}
                            className="flex items-center justify-between gap-3 px-4 py-2.5"
                          >
                            <div className="min-w-0">
                              <div className="text-sm truncate">{t.title}</div>
                              {t.due_date && (
                                <div
                                  className={
                                    overdue
                                      ? "text-xs text-danger font-medium"
                                      : "text-xs text-muted"
                                  }
                                >
                                  Due {formatDate(t.due_date)}
                                  {overdue ? " · overdue" : ""}
                                </div>
                              )}
                            </div>
                            <Badge tone={STATUS_TONE[t.status]}>
                              {STATUS_LABEL[t.status]}
                            </Badge>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  )
}
