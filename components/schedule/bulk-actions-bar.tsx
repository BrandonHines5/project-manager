"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { X, Calendar, CheckCircle2, Trash2, UserPlus, UserMinus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import {
  bulkSetScheduleStatus,
  bulkShiftScheduleDates,
  bulkDeleteScheduleItems,
  bulkAssignProfileToScheduleItems,
  bulkUnassignProfileFromScheduleItems,
  type MoveReasonT,
} from "@/app/actions/schedule"
import { MOVE_REASON_OPTIONS } from "./move-reason-dialog"

type StatusValue = "not_started" | "in_progress" | "complete" | "delayed"

type ProfileOption = {
  id: string
  full_name: string
  email: string | null
}

/**
 * Floating sticky bar that appears at the bottom of the schedule list view
 * whenever at least one item is checked. Hosts the bulk actions:
 *
 *  - Shift dates by ±N days (with cascade)
 *  - Set status (one of the four canonical states)
 *  - Assign to / unassign from a person
 *  - Delete (refuses if any selected item is a predecessor of an unselected
 *    item — staff are pointed at the single-item delete flow for that case)
 *
 * Action invocations clear the selection on success and call onResult so the
 * parent can surface a toast with the partial-failure detail.
 */
export function BulkActionsBar({
  projectId,
  selectedIds,
  profiles,
  onClear,
  baselineSet,
  hasWorkSelected,
}: {
  projectId: string
  selectedIds: string[]
  profiles: ProfileOption[]
  onClear: () => void
  // Baseline is locked for this project — shifting work items then requires
  // a reason (rendered inline in shift mode).
  baselineSet: boolean
  // At least one selected id is a work item; to-dos alone shift/complete
  // without the baseline rules.
  hasWorkSelected: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<
    "none" | "shift" | "status" | "assign" | "unassign"
  >("none")
  const [days, setDays] = useState("1")
  const [status, setStatus] = useState<StatusValue>("complete")
  const [reason, setReason] =
    useState<MoveReasonT["reason_category"]>("weather")
  const [reasonNotes, setReasonNotes] = useState("")
  const [profileId, setProfileId] = useState<string>(
    profiles[0]?.id ?? ""
  )

  if (selectedIds.length === 0) return null

  const shiftNeedsReason = baselineSet && hasWorkSelected

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
          move_reason: shiftNeedsReason
            ? { reason_category: reason, notes: reasonNotes || null }
            : null,
        })
        summarize(r, "shifted")
        // Only clear when at least one row was actually changed —
        // otherwise the staff loses the selection they need to retry
        // (CodeRabbit #30). Mirrors the delete branch.
        if (r.ok > 0) onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Shift failed")
      }
    })
  }

  function runStatus() {
    // No pre-check for complete-before-baseline here: the server skips the
    // affected work items and summarize() surfaces the reason, so partial
    // selections (to-dos + work) still do the valid part.
    startTransition(async () => {
      try {
        const r = await bulkSetScheduleStatus({
          project_id: projectId,
          ids: selectedIds,
          status,
        })
        summarize(r, `set to ${status.replace("_", " ")}`)
        if (r.ok > 0) onClear()
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

  function runAssign() {
    if (!profileId) {
      toast.error("Pick a person to assign.")
      return
    }
    const personName =
      profiles.find((p) => p.id === profileId)?.full_name ?? "assignee"
    startTransition(async () => {
      try {
        const r = await bulkAssignProfileToScheduleItems({
          project_id: projectId,
          ids: selectedIds,
          profile_id: profileId,
        })
        summarize(r, `assigned to ${personName}`)
        if (r.ok > 0) onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Assign failed")
      }
    })
  }

  function runUnassign() {
    if (!profileId) {
      toast.error("Pick a person to unassign.")
      return
    }
    const personName =
      profiles.find((p) => p.id === profileId)?.full_name ?? "assignee"
    startTransition(async () => {
      try {
        const r = await bulkUnassignProfileFromScheduleItems({
          project_id: projectId,
          ids: selectedIds,
          profile_id: profileId,
        })
        summarize(r, `unassigned from ${personName}`)
        if (r.ok > 0) onClear()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unassign failed")
      }
    })
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 w-[min(680px,calc(100vw-1rem))]">
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

        {mode === "shift" ? (
          <div className="flex items-center gap-1 flex-wrap">
            <Input
              type="number"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-7 w-20 bg-surface text-foreground"
              aria-label="Days to shift"
            />
            <span className="text-xs text-surface/70">days</span>
            {shiftNeedsReason && (
              <>
                <Select
                  value={reason}
                  onChange={(e) =>
                    setReason(
                      e.target.value as MoveReasonT["reason_category"]
                    )
                  }
                  className="h-7 w-36 bg-surface text-foreground"
                  aria-label="Reason for the shift"
                >
                  {MOVE_REASON_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Input
                  value={reasonNotes}
                  onChange={(e) => setReasonNotes(e.target.value)}
                  placeholder="Notes (optional)"
                  className="h-7 w-44 bg-surface text-foreground"
                  aria-label="Notes for the shift reason"
                />
              </>
            )}
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
              className="text-surface/80 hover:text-surface"
            >
              Cancel
            </Button>
          </div>
        ) : mode === "status" ? (
          <div className="flex items-center gap-1">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusValue)}
              className="h-7 w-36 bg-surface text-foreground"
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
              className="text-surface/80 hover:text-surface"
            >
              Cancel
            </Button>
          </div>
        ) : mode === "assign" || mode === "unassign" ? (
          <div className="flex items-center gap-1">
            <Select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="h-7 w-48 bg-surface text-foreground"
              aria-label={mode === "assign" ? "Person to assign" : "Person to unassign"}
            >
              {profiles.length === 0 ? (
                <option value="">(no staff profiles)</option>
              ) : (
                profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email || p.id.slice(0, 8)}
                  </option>
                ))
              )}
            </Select>
            <Button
              size="sm"
              onClick={mode === "assign" ? runAssign : runUnassign}
              disabled={pending || profiles.length === 0}
              variant="primary"
            >
              {pending
                ? mode === "assign"
                  ? "Assigning…"
                  : "Removing…"
                : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("none")}
              className="text-surface/80 hover:text-surface"
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
              className="text-surface/90 hover:text-surface hover:bg-surface/10"
            >
              <Calendar className="h-3.5 w-3.5 mr-1" />
              Shift dates
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("status")}
              className="text-surface/90 hover:text-surface hover:bg-surface/10"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Set status
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("assign")}
              className="text-surface/90 hover:text-surface hover:bg-surface/10"
            >
              <UserPlus className="h-3.5 w-3.5 mr-1" />
              Assign to
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode("unassign")}
              className="text-surface/90 hover:text-surface hover:bg-surface/10"
            >
              <UserMinus className="h-3.5 w-3.5 mr-1" />
              Unassign
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={runDelete}
              disabled={pending}
              className="text-danger hover:bg-danger/20"
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
