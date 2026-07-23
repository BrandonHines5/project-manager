"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Plus, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { formatDate } from "@/lib/utils"
import { LogCommentsToggle } from "@/components/daily-logs/log-comments-toggle"
import { DailyLogDrawer } from "@/components/daily-logs/daily-log-drawer"
import type { DailyLogsData } from "@/app/(app)/projects/[id]/daily-logs/daily-logs-client"

type LogComment = {
  id: string
  author_name: string
  author_role: null
  body: string
  created_at: string
}

export type DailyLogRow = {
  id: string
  project_id: string
  log_date: string
  notes: string | null
  showVisibility: boolean
  canPost: boolean
  comments: LogComment[]
  project: { name: string; project_number: string } | null
}

// Everything the staff-only create flow needs: the jobs the picker offers
// (with cost_plus so the drawer knows to show the hours field) and the
// org-wide lists the drawer's to-do/subs editors use. Null for non-staff.
export type CreateLogData = {
  meName: string
  projects: {
    id: string
    name: string
    project_number: string
    cost_plus: boolean
  }[]
  profiles: DailyLogsData["profiles"]
  companies: DailyLogsData["companies"]
}

export function AllDailyLogsList({
  rows,
  scopeLabel,
  truncated,
  meName,
  placeholder,
  create,
}: {
  rows: DailyLogRow[]
  scopeLabel: string
  truncated: boolean
  meName: string
  placeholder: string
  create: CreateLogData | null
}) {
  const [query, setQuery] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickedProjectId, setPickedProjectId] = useState("")
  const [drawerProject, setDrawerProject] = useState<
    CreateLogData["projects"][number] | null
  >(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (log) =>
        (log.notes?.toLowerCase().includes(q) ?? false) ||
        (log.project?.name.toLowerCase().includes(q) ?? false) ||
        (log.project?.project_number.toLowerCase().includes(q) ?? false)
    )
  }, [rows, query])

  const active = query.trim().length > 0

  function openPicker() {
    setPickedProjectId("")
    setPickerOpen(true)
  }

  function startLog() {
    const project =
      create?.projects.find((p) => p.id === pickedProjectId) ?? null
    if (!project) return
    setPickerOpen(false)
    setDrawerProject(project)
  }

  // The drawer's create mode only reads the project, the people/company
  // lists, and cost_plus — the per-log collections can stay empty.
  const drawerData: DailyLogsData | null =
    create && drawerProject
      ? {
          project_id: drawerProject.id,
          role: "staff",
          me_name: create.meName,
          cost_plus: drawerProject.cost_plus,
          logs: [],
          subs_on_site: [],
          attachments: [],
          profiles: create.profiles,
          companies: create.companies,
          signed_urls: {},
          comments: [],
          open_log_id: null,
        }
      : null

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <div className="relative max-w-md flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs or jobs…"
            aria-label="Search job logs"
            className="w-full h-10 pl-9 pr-3 text-sm rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          />
        </div>
        {create && (
          <Button onClick={openPicker}>
            <Plus className="h-4 w-4" /> New job log
          </Button>
        )}
      </div>

      <div className="mb-4 text-sm text-muted">
        {active
          ? `${filtered.length} of ${rows.length} log${
              rows.length === 1 ? "" : "s"
            } match`
          : `${filtered.length} log${filtered.length === 1 ? "" : "s"}`}{" "}
        across {scopeLabel}
        {truncated && !active && " (showing latest 200)"}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted py-12 text-center border border-dashed border-border-strong rounded-lg">
          {active
            ? "No job logs match your search."
            : "No job logs in these jobs."}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((log) => (
            <li
              key={log.id}
              className="bg-surface border border-border rounded-lg p-4"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {log.project && (
                    <Link
                      href={`/projects/${log.project_id}/daily-logs`}
                      className="text-xs font-mono text-brand-600 hover:underline shrink-0"
                    >
                      {log.project.project_number}
                    </Link>
                  )}
                  <span className="text-sm font-medium truncate">
                    {log.project?.name ?? "—"}
                  </span>
                  {log.showVisibility && <Badge tone="muted">Internal</Badge>}
                </div>
                <div className="text-xs text-muted shrink-0">
                  {formatDate(log.log_date)}
                </div>
              </div>
              {log.notes && (
                <p className="text-sm whitespace-pre-wrap line-clamp-4">
                  {log.notes}
                </p>
              )}
              <LogCommentsToggle
                dailyLogId={log.id}
                projectId={log.project_id}
                comments={log.comments}
                meName={meName}
                canPost={log.canPost}
                placeholder={placeholder}
              />
            </li>
          ))}
        </ul>
      )}

      {create && (
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent size="sm">
            <DialogHeader>
              <div>
                <DialogTitle>New job log</DialogTitle>
                <DialogDescription>
                  Which job is this log for?
                </DialogDescription>
              </div>
            </DialogHeader>
            <DialogBody>
              <Field label="Job">
                <SearchableSelect
                  value={pickedProjectId}
                  onChange={setPickedProjectId}
                  options={create.projects.map((p) => ({
                    value: p.id,
                    label: p.name,
                    hint: p.project_number,
                  }))}
                  placeholder="Select a job…"
                  ariaLabel="Job for the new log"
                  clearable={false}
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPickerOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={startLog}
                disabled={!pickedProjectId}
              >
                Continue
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {drawerData && (
        <DailyLogDrawer
          key={drawerData.project_id}
          open={true}
          onClose={() => setDrawerProject(null)}
          data={drawerData}
          mode="create"
        />
      )}
    </div>
  )
}
