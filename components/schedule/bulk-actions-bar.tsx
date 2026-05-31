"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { X, Calendar, CheckCircle2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import {
  bulkSetScheduleStatus,
  bulkShiftScheduleDates,
  bulkDeleteScheduleItems,
} from "@/app/actions/schedule"

type StatusValue = "not_started" | "in_progress" | "complete" | "delayed"

/**
 * Floating sticky bar that appears at the bottom of the schedule list view
 * whenever at least one item is checked. Hosts the bulk actions:
 *
 *  - Shift dates by ±N days (with cascade)
 *  - Set status (one of the four canonical states)
 *  - Delete (refuses if any selected item is a predecessor of an unselected
 *    item — staff are pointed at the single-item delete flow for that case)
 *
 * Action invocations clear the selection on success and call onResult so the
 * parent can surface a toast with the partial-failure detail.
 */
export function BulkActionsBar({
  projectId,
  selectedIds,
  onClear,
}: {
  projectId: string
  selectedIds: string[]
  onClear: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<"none" | "shift" | "status" | "delete">(
    "none"
  )
  const [days, setDays] = useState("1")
  const [status, setStatus] = useState<StatusValue>("complete")

  if (selectedIds.length === 0) return null

  function runShift() {
    const n = Number(days)
    if (!Number.isFinite(n) || n === 0) {
      toast.error("Enter a non-zero number of days.")
      return
    }
    startTransition(async () => {
      try {
        const r = await bulkShiftScheduleDates({
          project_id: projectId,
          ids: selectedIds,
          days: Math.trunc(n),
        })
        summarize(r, "shifted")
        onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Shift failed")
      }
    })
  }

  function runStatus() {
    startTransition(async () => {
      try {
        const r = await bulkSetScheduleStatus({
          project_id: projectId,
          ids: selectedIds,
          status,
        })
        summarize(r, `set to ${status.replace("_", " ")}`)
        onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Status update failed")
      }
    })
  }

  function runDelete() {
    if (
      !confirm(
        `Delete ${selectedIds.length} schedule item${selectedIds.length === 1 ? "" : "s"}? Items that are predecessors of unselected items will be skipped.`
      )
    ) {
      return
    }
    startTransition(async () => {
      try {
        const r = await bulkDeleteScheduleItems({
          project_id: projectId,
          ids: selectedIds,
        })
        summarize(r, "deleted")
        if (r.ok > 0) onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 w-[min(680px,calc(100vw-1rem))]">
      <div className="bg-foreground text-white rounded-lg shadow-2xl border border-foreground/30 px-3 py-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {selectedIds.length} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="text-white/60 hover:text-white p-1 cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="h-5 w-px bg-white/20 mx-1" />

        {mode === "shift" ? (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-7 w-20 bg-white text-foreground"
              aria-label="Days to shift"
            />
            <span className="text-xs text-white/70">days</span>
            <Button
              size="sm"
              onClick={runShift}
              disabled={pending}
              variant="primary"
            >
              {pending ? "Shifting…" : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("none")}
              className="text-white/80 hover:text-white"
            >
              Cancel
            </Button>
          </div>
        ) : mode === "status" ? (
          <div className="flex items-center gap-1">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusValue)}
              className="h-7 w-36 bg-white text-foreground"
              aria-label="New status"
            >
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="complete">Complete</option>
              <option value="delayed">Delayed</option>
            </Select>
            <Button
              size="sm"
              onClick={runStatus}
              disabled={pending}
              variant="primary"
            >
              {pending ? "Setting…" : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("none")}
              className="text-white/80 hover:text-white"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("shift")}
              className="text-white/90 hover:text-white hover:bg-white/10"
            >
              <Calendar className="h-3.5 w-3.5 mr-1" />
              Shift dates
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("status")}
              className="text-white/90 hover:text-white hover:bg-white/10"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Set status
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={runDelete}
              disabled={pending}
              className="text-red-200 hover:text-red-100 hover:bg-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {pending ? "Working…" : "Delete"}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function summarize(
  result: { ok: number; skipped: { id: string; reason: string }[] },
  verb: string
) {
  if (result.ok === 0 && result.skipped.length > 0) {
    // All skipped — surface the first reason so the user understands why.
    toast.error(
      `Nothing ${verb}. ${result.skipped.length} item${result.skipped.length === 1 ? "" : "s"} skipped: ${result.skipped[0].reason}${
        result.skipped.length > 1
          ? ` (+${result.skipped.length - 1} more)`
          : ""
      }`
    )
    return
  }
  if (result.skipped.length > 0) {
    toast.warning(
      `${result.ok} ${verb}, ${result.skipped.length} skipped (${result.skipped[0].reason})`
    )
    return
  }
  toast.success(`${result.ok} ${verb}`)
}
