"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy, AlertTriangle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Select } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  getCopyTodoData,
  copyTodoToTargets,
  type CopyTodoData,
} from "@/app/actions/schedule"

type Override = { parent_id: string; due_date: string }

export function CopyTodoDialog({
  open,
  onClose,
  sourceItemId,
  currentProjectId,
}: {
  open: boolean
  onClose: () => void
  sourceItemId: string
  currentProjectId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<CopyTodoData | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Per-project parent + due overrides, keyed by project id. Only required for
  // projects where the parent can't be auto-resolved.
  const [overrides, setOverrides] = useState<Record<string, Override>>({})

  useEffect(() => {
    // `loading` starts true; the dialog mounts fresh per open so there's no
    // need to reset it synchronously here (that also trips the
    // set-state-in-effect lint rule).
    let active = true
    getCopyTodoData({ source_item_id: sourceItemId })
      .then((d) => {
        if (active) setData(d)
      })
      .catch((e) => {
        if (active) {
          const msg = e instanceof Error ? e.message : "Could not load projects"
          setLoadError(msg)
          toast.error(msg)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [sourceItemId])

  // For a given project, work out how the parent resolves:
  //  - "none"  → source has no parent; nothing to link.
  //  - "auto"  → a work item with the same title exists; we link it silently.
  //  - "ask"   → source has a parent but no match here; prompt for parent+due.
  function resolution(projectId: string): {
    kind: "none" | "auto" | "ask"
    autoTitle?: string
  } {
    if (!data) return { kind: "none" }
    if (!data.source.parent_title) return { kind: "none" }
    const proj = data.projects.find((p) => p.id === projectId)
    const match = proj?.work_items.find(
      (w) =>
        w.title.trim().toLowerCase() ===
        data.source.parent_title!.trim().toLowerCase()
    )
    if (match) return { kind: "auto", autoTitle: match.title }
    return { kind: "ask" }
  }

  function toggle(projectId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  function setOverride(projectId: string, patch: Partial<Override>) {
    setOverrides((prev) => ({
      ...prev,
      [projectId]: {
        parent_id: patch.parent_id ?? prev[projectId]?.parent_id ?? "",
        due_date: patch.due_date ?? prev[projectId]?.due_date ?? "",
      },
    }))
  }

  function handleCopy() {
    if (selected.size === 0) {
      toast.error("Pick at least one job to copy into")
      return
    }
    // Validate that every "ask" project has a parent + due date.
    const targets: {
      project_id: string
      parent_id?: string | null
      due_date?: string | null
    }[] = []
    for (const projectId of selected) {
      const res = resolution(projectId)
      if (res.kind === "ask") {
        const ov = overrides[projectId]
        if (!ov?.parent_id || !ov?.due_date) {
          const label =
            data?.projects.find((p) => p.id === projectId)?.label ?? "a job"
          toast.error(`Pick a parent and due date for "${label}"`)
          return
        }
        targets.push({
          project_id: projectId,
          parent_id: ov.parent_id,
          due_date: ov.due_date,
        })
      } else {
        targets.push({ project_id: projectId })
      }
    }

    startTransition(async () => {
      try {
        const res = await copyTodoToTargets({
          source_item_id: sourceItemId,
          targets,
        })
        if (res.created > 0) {
          toast.success(
            `Copied to ${res.created} job${res.created === 1 ? "" : "s"}`
          )
        }
        if (res.skipped.length > 0) {
          toast.error(
            `${res.skipped.length} job${
              res.skipped.length === 1 ? "" : "s"
            } skipped`
          )
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Copy failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div>
            <DialogTitle>Copy to-do to job</DialogTitle>
            <DialogDescription>
              {data
                ? `Copy "${data.source.title}" into other jobs. ${
                    data.source.parent_title
                      ? `It links under a "${data.source.parent_title}" work item where one exists.`
                      : "It copies as a standalone to-do."
                  }`
                : "Loading…"}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : loadError ? (
            <p className="text-sm text-danger py-6 text-center">
              Couldn&apos;t load jobs: {loadError}
            </p>
          ) : !data || data.projects.length === 0 ? (
            <p className="text-sm text-muted py-6 text-center">
              No jobs available to copy into.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.projects.map((proj) => {
                const isSel = selected.has(proj.id)
                const res = resolution(proj.id)
                const isCurrent = proj.id === currentProjectId
                return (
                  <li
                    key={proj.id}
                    className={cn(
                      "rounded-md border p-2.5",
                      isSel ? "border-brand-500 bg-brand-50/50" : "border-border"
                    )}
                  >
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggle(proj.id)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm font-medium flex-1">
                        {proj.label}
                        {isCurrent && (
                          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted">
                            (this job)
                          </span>
                        )}
                      </span>
                      {isSel && res.kind === "auto" && (
                        <span className="text-[11px] text-muted">
                          → under {res.autoTitle}
                        </span>
                      )}
                      {isSel && res.kind === "none" && (
                        <span className="text-[11px] text-muted">
                          standalone
                        </span>
                      )}
                    </label>

                    {isSel && res.kind === "ask" && (
                      <div className="mt-2 pl-6 space-y-2">
                        <div className="flex items-start gap-1.5 text-[11px] text-warning">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            No matching parent here. Pick a parent work item and
                            due date.
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Field label="Parent work item">
                            <Select
                              value={overrides[proj.id]?.parent_id ?? ""}
                              onChange={(e) =>
                                setOverride(proj.id, {
                                  parent_id: e.target.value,
                                })
                              }
                            >
                              <option value="">Choose…</option>
                              {proj.work_items.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.title}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Due date">
                            <Input
                              type="date"
                              value={overrides[proj.id]?.due_date ?? ""}
                              onChange={(e) =>
                                setOverride(proj.id, {
                                  due_date: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </div>
                        {proj.work_items.length === 0 && (
                          <p className="text-[11px] text-danger">
                            This job has no work items to nest under.
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleCopy}
            disabled={pending || loading || selected.size === 0}
          >
            <Copy className="h-4 w-4" />
            {pending ? "Copying…" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
