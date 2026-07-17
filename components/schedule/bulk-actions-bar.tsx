"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { toastActionError } from "@/lib/action-error"
import {
  X,
  Calendar,
  CheckCircle2,
  Trash2,
  UserPlus,
  UserMinus,
  Copy,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import {
  bulkSetScheduleStatus,
  bulkShiftScheduleDates,
  bulkDeleteScheduleItems,
  bulkAssignProfileToScheduleItems,
  bulkUnassignProfileFromScheduleItems,
  bulkAssignRoleToScheduleItems,
  bulkUnassignRoleFromScheduleItems,
  bulkCopyScheduleItems,
} from "@/app/actions/schedule"
import { MOVE_REASON_OPTIONS } from "./move-reason-dialog"
import type { DelayReason } from "@/lib/delays"

type StatusValue = "not_started" | "in_progress" | "complete" | "delayed"

type ProfileOption = {
  id: string
  full_name: string
  email: string | null
}

type RoleOption = {
  id: string
  label: string
}

type ProjectOption = {
  id: string
  label: string
}

/**
 * Floating sticky bar that appears at the bottom of the schedule list view
 * whenever at least one item is checked. Hosts the bulk actions:
 *
 *  - Shift dates by ±N days (with cascade)
 *  - Set status (one of the four canonical states)
 *  - Assign to / unassign from a person OR a project role
 *  - Copy the selection to another job
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
  roles,
  projects,
  delayReasons,
  onClear,
  baselineSet,
  hasWorkSelected,
}: {
  projectId: string
  selectedIds: string[]
  profiles: ProfileOption[]
  // Role catalog with resolved labels ("Site Superintendent (Sam)") — assign
  // targets alongside people.
  roles: RoleOption[]
  // Copy-to-job destinations (current project excluded by the parent).
  projects: ProjectOption[]
  // Staff-editable delay reasons for the shift-mode reason picker.
  delayReasons: DelayReason[]
  onClear: () => void
  // Baseline is locked for this project — shifting work items then requires
  // a reason (rendered inline in shift mode).
  baselineSet: boolean
  // At least one selected id is a work item; to-dos alone shift/complete
  // without the baseline rules.
  hasWorkSelected: boolean
}) {
  const reasonOptions = delayReasons.length ? delayReasons : MOVE_REASON_OPTIONS
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<
    "none" | "shift" | "status" | "assign" | "unassign" | "copy"
  >("none")
  const [days, setDays] = useState("1")
  const [status, setStatus] = useState<StatusValue>("complete")
  const [reason, setReason] = useState<string>(
    reasonOptions[0]?.value ?? "other"
  )
  const [reasonNotes, setReasonNotes] = useState("")
  // "p:<id>" for a person, "r:<id>" for a role.
  const [assignee, setAssignee] = useState<string>(
    profiles[0] ? `p:${profiles[0].id}` : roles[0] ? `r:${roles[0].id}` : ""
  )
  const [targetProjectId, setTargetProjectId] = useState<string>(
    projects[0]?.id ?? ""
  )

  if (selectedIds.length === 0) return null

  const shiftNeedsReason = baselineSet && hasWorkSelected

  function assigneeName(value: string): string {
    if (value.startsWith("p:")) {
      const p = profiles.find((x) => x.id === value.slice(2))
      return p?.full_name || p?.email || "assignee"
    }
    return roles.find((r) => r.id === value.slice(2))?.label ?? "role"
  }

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
        toastActionError(e, "Shift failed")
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
        toastActionError(e, "Status update failed")
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
        toastActionError(e, "Delete failed")
      }
    })
  }

  function runAssign(direction: "assign" | "unassign") {
    if (!assignee) {
      toast.error(
        direction === "assign"
          ? "Pick a person or role to assign."
          : "Pick a person or role to unassign."
      )
      return
    }
    const name = assigneeName(assignee)
    const id = assignee.slice(2)
    const isRole = assignee.startsWith("r:")
    startTransition(async () => {
      try {
        const r = isRole
          ? direction === "assign"
            ? await bulkAssignRoleToScheduleItems({
                project_id: projectId,
                ids: selectedIds,
                role_id: id,
              })
            : await bulkUnassignRoleFromScheduleItems({
                project_id: projectId,
                ids: selectedIds,
                role_id: id,
              })
          : direction === "assign"
            ? await bulkAssignProfileToScheduleItems({
                project_id: projectId,
                ids: selectedIds,
                profile_id: id,
              })
            : await bulkUnassignProfileFromScheduleItems({
                project_id: projectId,
                ids: selectedIds,
                profile_id: id,
              })
        summarize(
          r,
          direction === "assign" ? `assigned to ${name}` : `unassigned from ${name}`
        )
        if (r.ok > 0) onClear()
      } catch (e) {
        toastActionError(
          e,
          direction === "assign" ? "Assign failed" : "Unassign failed"
        )
      }
    })
  }

  function runCopy() {
    if (!targetProjectId) {
      toast.error("Pick a job to copy into.")
      return
    }
    const targetLabel =
      projects.find((p) => p.id === targetProjectId)?.label ?? "the job"
    startTransition(async () => {
      try {
        const r = await bulkCopyScheduleItems({
          project_id: projectId,
          ids: selectedIds,
          target_project_id: targetProjectId,
        })
        summarize(r, `copied to ${targetLabel}`)
        if (r.ok > 0) onClear()
      } catch (e) {
        toastActionError(e, "Copy failed")
      }
    })
  }

  const assigneePicker = (
    <Select
      value={assignee}
      onChange={(e) => setAssignee(e.target.value)}
      className="h-7 w-52 bg-surface text-foreground"
      aria-label={
        mode === "assign" ? "Person or role to assign" : "Person or role to unassign"
      }
    >
      {profiles.length === 0 && roles.length === 0 ? (
        <option value="">(no people or roles)</option>
      ) : (
        <>
          {profiles.length > 0 && (
            <optgroup label="People">
              {profiles.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>
                  {p.full_name || p.email || p.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          )}
          {roles.length > 0 && (
            <optgroup label="Roles">
              {roles.map((r) => (
                <option key={r.id} value={`r:${r.id}`}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          )}
        </>
      )}
    </Select>
  )

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 w-[min(720px,calc(100vw-1rem))]">
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
                  onChange={(e) => setReason(e.target.value)}
                  className="h-7 w-36 bg-surface text-foreground"
                  aria-label="Reason for the shift"
                >
                  {reasonOptions.map((o) => (
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
            {assigneePicker}
            <Button
              size="sm"
              onClick={() => runAssign(mode)}
              disabled={pending || (profiles.length === 0 && roles.length === 0)}
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
        ) : mode === "copy" ? (
          <div className="flex items-center gap-1">
            <Select
              value={targetProjectId}
              onChange={(e) => setTargetProjectId(e.target.value)}
              className="h-7 w-56 bg-surface text-foreground"
              aria-label="Job to copy into"
            >
              {projects.length === 0 ? (
                <option value="">(no other jobs)</option>
              ) : (
                projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))
              )}
            </Select>
            <Button
              size="sm"
              onClick={runCopy}
              disabled={pending || projects.length === 0}
              variant="primary"
            >
              {pending ? "Copying…" : "Copy"}
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
              onClick={() => setMode("copy")}
              className="text-surface/90 hover:text-surface hover:bg-surface/10"
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copy to job
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
