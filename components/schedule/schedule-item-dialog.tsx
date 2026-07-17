"use client"

import { useState, useTransition, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  AlertTriangle,
  GripVertical,
  MessageSquare,
  Copy,
  Flag,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Textarea, Select, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  cn,
  formatDate,
  formatDateRange,
  addBusinessDays,
  addDays,
  nextBusinessDay,
  businessDaysBetween,
  endDateFromDuration,
} from "@/lib/utils"
import {
  saveScheduleItem,
  deleteScheduleItem,
  getPredecessorDependents,
  logDelay,
  sendQuoTextToSub,
  postScheduleItemComment,
  type MoveReasonT,
  type ScheduleItemInputT,
  type SchedulePredecessorDependent,
} from "@/app/actions/schedule"
import { CommentsThread } from "@/components/comms/comments-thread"
import { delayReasonLabel, type DelayReason } from "@/lib/delays"
import { MoveReasonDialog } from "./move-reason-dialog"
import { DeleteWithDependentsDialog } from "./delete-with-dependents-dialog"
import { CopyTodoDialog } from "./copy-todo-dialog"
import {
  AttachmentsEditor,
  AttachmentsCreatePlaceholder,
} from "./attachments-editor"
import type {
  RecurrenceRule,
  RecurrenceFreq,
} from "@/lib/schedule/recurrence"
import { isRecurrenceRule, describeRecurrence } from "@/lib/schedule/recurrence"
import { formatTags, parseTagsInput, collectBaseTags } from "@/lib/template-tags"
import { TemplateTagsInput } from "@/components/template-tags-input"
import type { Tables, Enums } from "@/lib/db/types"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import { checklistFor, predecessorsOf, delaysFor, resolveRoleLabel } from "./helpers"

type Mode = "create" | "edit"

type Assignment = {
  profile_id?: string | null
  company_id?: string | null
  role_id?: string | null
}
type ChecklistItem = {
  id?: string
  label: string
  is_done: boolean
  assignee_profile_id?: string | null
  assignee_company_id?: string | null
  assignee_role_id?: string | null
}
type PredEdit = { predecessor_id: string; dep_type: Enums<"dependency_type">; lag_days: number }

export function ScheduleItemDialog({
  open,
  onClose,
  mode,
  item,
  defaultKind,
  defaultParentId,
  data,
}: {
  open: boolean
  onClose: () => void
  mode: Mode
  item?: Tables<"schedule_items">
  defaultKind?: "work" | "todo"
  defaultParentId?: string
  data: ScheduleData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const initialKind: "work" | "todo" =
    mode === "edit" && item ? item.kind : defaultKind ?? "work"

  const [kind, setKind] = useState<"work" | "todo">(initialKind)
  const [title, setTitle] = useState(item?.title ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [templateTagsText, setTemplateTagsText] = useState(
    formatTags(item?.template_tags)
  )
  // Existing template-tag vocabulary across this project's schedule items, so
  // the tags field can suggest reusing one instead of coining a variant.
  const tagSuggestions = useMemo(
    () => collectBaseTags(data.items.map((i) => i.template_tags)),
    [data.items]
  )
  const [startDate, setStartDate] = useState(item?.start_date ?? "")
  const [endDate, setEndDate] = useState(item?.end_date ?? "")
  // Duration is in business days (M–F). Derived from start+end on existing
  // items; otherwise blank.
  const [duration, setDuration] = useState<string>(() => {
    if (item?.start_date && item?.end_date) {
      return String(businessDaysBetween(item.start_date, item.end_date))
    }
    return ""
  })
  const [dueDate, setDueDate] = useState(item?.due_date ?? "")
  // Work-item-only: keep this item off the critical path (e.g. a completion
  // target that isn't real on-site work).
  const [excludeFromCritical, setExcludeFromCritical] = useState(
    item?.exclude_from_critical_path ?? false
  )
  // Anchor: when on, the to-do's due_date is computed from the parent's
  // chosen anchor date + offset, and the manual `dueDate` field is hidden.
  const [anchorEnabled, setAnchorEnabled] = useState(
    !!item?.parent_anchor
  )
  const [anchor, setAnchor] = useState<"start" | "end">(
    item?.parent_anchor ?? "end"
  )
  const [anchorOffset, setAnchorOffset] = useState<string>(
    item?.parent_offset_days != null ? String(item.parent_offset_days) : "0"
  )

  // Recompute end from start + duration. Called when either changes.
  function applyDuration(nextStart: string, nextDuration: string) {
    const n = Number(nextDuration)
    if (nextStart && Number.isFinite(n) && n > 0) {
      setEndDate(endDateFromDuration(nextStart, n))
    }
  }
  function onChangeStartDate(v: string) {
    setStartDate(v)
    if (duration) applyDuration(v, duration)
  }
  function onChangeDuration(v: string) {
    setDuration(v)
    if (startDate) applyDuration(startDate, v)
  }
  function onChangeEndDate(v: string) {
    setEndDate(v)
    if (startDate && v) {
      setDuration(String(businessDaysBetween(startDate, v)))
    }
  }
  // Called by PredecessorsEditor whenever a predecessor is added or its
  // type / lag is changed. Always re-anchors the start date so the form
  // reflects the chosen relationship — earlier behaviour was to skip when
  // a start date already existed, which made users wonder why the date
  // didn't update after picking a different predecessor.
  function onPredecessorAdded(p: { predecessor_id: string; dep_type: string; lag_days: number }) {
    const pred = data.items.find((it) => it.id === p.predecessor_id)
    if (!pred) return
    let basis = ""
    if (p.dep_type === "FS" && pred.end_date) basis = pred.end_date
    else if (p.dep_type === "SS" && pred.start_date) basis = pred.start_date
    else if (p.dep_type === "FF" && pred.end_date) basis = pred.end_date
    else if (p.dep_type === "SF" && pred.start_date) basis = pred.start_date
    if (!basis) return
    // FS / SS: start AT (or after) the basis + lag + 1 business day (FS only).
    // FF / SF: align end first; we approximate by starting at basis + lag.
    // Lag may be negative (lead time) — addBusinessDays walks backwards.
    const lagApplied = addBusinessDays(basis, p.lag_days)
    const newStart =
      p.dep_type === "FS"
        ? addBusinessDays(lagApplied, 1)
        : nextBusinessDay(lagApplied)
    setStartDate(newStart)
    if (duration) applyDuration(newStart, duration)
  }
  const [status, setStatus] = useState<Enums<"schedule_item_status">>(
    item?.status ?? "not_started"
  )
  const [priority, setPriority] = useState<Enums<"todo_priority"> | "">(
    item?.priority ?? ""
  )
  const [parentId, setParentId] = useState<string | "">(
    item?.parent_id ?? defaultParentId ?? ""
  )
  const [recurrence, setRecurrence] = useState<RecurrenceRule | null>(
    isRecurrenceRule(item?.recurrence_rule) ? item!.recurrence_rule : null
  )
  const [assignments, setAssignments] = useState<Assignment[]>(() => {
    if (!item) return []
    return data.assignments
      .filter((a) => a.schedule_item_id === item.id)
      .map((a) => ({
        profile_id: a.profile_id ?? undefined,
        company_id: a.company_id ?? undefined,
        role_id: a.role_id ?? undefined,
      }))
  })
  const [checklist, setChecklist] = useState<ChecklistItem[]>(() => {
    if (!item) return []
    return checklistFor(item.id, data.checklist).map((c) => ({
      id: c.id,
      label: c.label,
      is_done: c.is_done,
      assignee_profile_id: c.assignee_profile_id,
      assignee_company_id: c.assignee_company_id,
      assignee_role_id: c.assignee_role_id,
    }))
  })
  const [predecessors, setPredecessors] = useState<PredEdit[]>(() => {
    if (!item) return []
    return predecessorsOf(item.id, data.predecessors).map((p) => ({
      predecessor_id: p.predecessor_id,
      dep_type: p.dep_type,
      lag_days: p.lag_days,
    }))
  })
  const [showDelay, setShowDelay] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  // A save that moved a baselined work item's dates parks here until the
  // user picks a reason in the popup (andCopy preserves "Save & copy" intent).
  const [pendingReasonSave, setPendingReasonSave] = useState<{
    payload: ScheduleItemInputT
    andCopy: boolean
  } | null>(null)
  const baselineSet = !!data.baseline_set_at
  const isMilestone = !!item?.milestone
  const [dependents, setDependents] = useState<
    SchedulePredecessorDependent[] | null
  >(null)
  type AttachmentWithUrl = Tables<"schedule_item_attachments"> & {
    signed_url?: string | null
  }
  const [attachmentsState, setAttachmentsState] = useState<AttachmentWithUrl[]>(
    () => {
      if (!item) return []
      return data.attachments
        .filter((a) => a.schedule_item_id === item.id)
        .map((a) => ({
          ...a,
          signed_url: data.signed_urls[a.storage_path] ?? null,
        }))
    }
  )

  // Mirror the server's sole-assignee rule live: when the to-do ends up with
  // exactly one assignee, every checklist item follows it (the server
  // re-applies the same rule on save, so this is purely so the user sees the
  // effect before saving).
  function handleAssignmentsChange(next: Assignment[]) {
    setAssignments(next)
    if (kind === "todo" && next.length === 1) {
      const sole = next[0]
      setChecklist((cl) =>
        cl.map((c) => ({
          ...c,
          assignee_profile_id: sole.profile_id ?? null,
          assignee_company_id: sole.company_id ?? null,
          assignee_role_id: sole.role_id ?? null,
        }))
      )
    }
  }

  // Sorted alphabetically by title so the "Parent work item" picker is easy
  // to scan on jobs with a long schedule (matches the predecessor picker).
  // filter() returns a fresh array, so the sort doesn't mutate data.items.
  const workItemOptions = data.items
    .filter((i) => i.kind === "work" && i.id !== item?.id)
    .sort((a, b) => a.title.localeCompare(b.title))
  const itemsForPredecessors = data.items.filter(
    (i) => i.kind === "work" && i.id !== item?.id
  )

  // Validates the form and assembles the server payload. Returns null (after
  // toasting the reason) when the form isn't valid, so callers can bail.
  function buildPayload(): ScheduleItemInputT | null {
    if (!title.trim()) {
      toast.error("Title is required")
      return null
    }
    if (kind === "work" && startDate && endDate && endDate < startDate) {
      toast.error("End date must be on or after start date")
      return null
    }
    // Work items can't be completed until the baseline is locked (to-dos
    // can). Mirrors the server-side gate so the user gets a clear message
    // instead of a masked production error.
    if (
      kind === "work" &&
      status === "complete" &&
      !baselineSet &&
      (mode === "create" || item?.status !== "complete")
    ) {
      toast.error(
        "Set the schedule baseline before marking work items complete — use “Set baseline” at the top of the page."
      )
      return null
    }
    const anchored = kind === "todo" && !!parentId && anchorEnabled
    // A recurrence rule advances from the due date — without one there is no
    // anchor and the repeat never fires. Anchored to-dos derive their due date
    // from the parent work item, so the chosen anchor date must actually
    // exist on the parent or the derived due date is null and the series
    // never rolls.
    const anchorParent = anchored
      ? data.items.find((i) => i.id === parentId)
      : null
    const anchoredDueBasis =
      anchored && anchorParent
        ? anchor === "start"
          ? anchorParent.start_date
          : anchorParent.end_date
        : null
    if (
      kind === "todo" &&
      recurrence &&
      ((!anchored && !dueDate) || (anchored && !anchoredDueBasis))
    ) {
      toast.error(
        anchored
          ? "Recurring to-dos need a due date — give the parent work item its dates first, or unlink and set a due date."
          : "Recurring to-dos need a due date — the repeat schedule counts from it."
      )
      return null
    }
    return {
      id: item?.id,
      project_id: data.project_id,
      parent_id: kind === "todo" ? (parentId || null) : null,
      kind,
      title: title.trim(),
      description: description || null,
      start_date: kind === "work" ? startDate || "" : "",
      end_date: kind === "work" ? endDate || "" : "",
      // When anchored, the server recomputes due_date from the parent — any
      // value here is ignored. Send "" so we don't mislead.
      due_date: kind === "todo" && !anchored ? dueDate || "" : "",
      parent_anchor: anchored ? anchor : null,
      // Server enforces .int(); truncate decimals here so a "1.5" entry
      // doesn't get rejected at the schema layer with a confusing error.
      parent_offset_days: anchored
        ? Math.trunc(Number(anchorOffset) || 0)
        : null,
      status,
      // Only work items appear on the critical path, so the flag is only
      // meaningful there — send false for to-dos.
      exclude_from_critical_path: kind === "work" ? excludeFromCritical : false,
      priority: kind === "todo" ? (priority || null) : null,
      recurrence_rule: kind === "todo" ? recurrence : null,
      template_tags: parseTagsInput(templateTagsText),
      assignments,
      checklist: kind === "todo" ? checklist : [],
      predecessors: kind === "work" ? predecessors : [],
    }
  }

  // Mirrors the server's lone-date completion (a work item with only one
  // date gets it mirrored to the other side) so the "did the dates move?"
  // check compares what will actually be stored.
  function effectiveDates(p: ScheduleItemInputT): {
    start: string | null
    end: string | null
  } {
    let s = p.start_date && p.start_date !== "" ? p.start_date : null
    let e = p.end_date && p.end_date !== "" ? p.end_date : null
    if (p.kind === "work") {
      if (s && !e) e = s
      else if (e && !s) s = e
    }
    return { start: s, end: e }
  }

  // Post-baseline date changes on a work item must carry a reason — park the
  // payload and open the popup instead of saving straight away.
  function needsMoveReason(payload: ScheduleItemInputT): boolean {
    if (mode !== "edit" || !item || item.kind !== "work" || !baselineSet) {
      return false
    }
    const { start, end } = effectiveDates(payload)
    return item.start_date !== start || item.end_date !== end
  }

  function doSave(payload: ScheduleItemInputT, andCopy: boolean) {
    startTransition(async () => {
      try {
        await saveScheduleItem(payload)
        setPendingReasonSave(null)
        if (andCopy) {
          router.refresh()
          setShowCopy(true)
        } else {
          toast.success(mode === "edit" ? "Saved" : "Created")
          router.refresh()
          onClose()
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  async function handleSave() {
    const payload = buildPayload()
    if (!payload) return
    if (needsMoveReason(payload)) {
      setPendingReasonSave({ payload, andCopy: false })
      return
    }
    doSave(payload, false)
  }

  // Save first, then open the copy dialog — without this, the copy would
  // duplicate the last-persisted row and silently drop any unsaved edits the
  // user made in this drawer. We keep the drawer open so they land back here
  // after copying.
  function handleSaveAndCopy() {
    const payload = buildPayload()
    if (!payload) return
    if (needsMoveReason(payload)) {
      setPendingReasonSave({ payload, andCopy: true })
      return
    }
    doSave(payload, true)
  }

  async function handleDelete() {
    if (!item) return
    if (item.milestone) {
      toast.error(
        `"${item.title}" is a protected milestone and can't be deleted.`
      )
      return
    }
    // For work items, check whether any other items depend on this one as a
    // predecessor. If so, force the reassign-or-remove dialog before
    // touching the row.
    if (item.kind === "work") {
      try {
        const deps = await getPredecessorDependents({
          id: item.id,
          project_id: data.project_id,
        })
        if (deps.length > 0) {
          setDependents(deps)
          return
        }
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Could not check for dependents"
        )
        return
      }
    }
    if (!confirm("Delete this item? Sub-items will also be removed.")) return
    startTransition(async () => {
      try {
        await deleteScheduleItem({
          id: item.id,
          project_id: data.project_id,
        })
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  const delays = item ? delaysFor(item.id, data.delays) : []
  const comments = item
    ? data.comments.filter((c) => c.schedule_item_id === item.id)
    : []

  return (
    // While the move-reason popup is up, Esc/overlay events shouldn't also
    // dismiss this drawer (both dialogs listen on document) — the user would
    // lose their edits along with the popup.
    <Dialog
      open={open}
      onOpenChange={(v) => !v && !pendingReasonSave && onClose()}
    >
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <DialogTitle>
              {mode === "edit"
                ? title || "Edit item"
                : kind === "work"
                ? "New work item"
                : "New to-do"}
            </DialogTitle>
            <DialogDescription>
              {isMilestone
                ? "Protected milestone — it defines the tracked job duration and can't be deleted."
                : kind === "work"
                ? "Primary on-site work with start/end dates."
                : "A task that may roll up under a work item."}
            </DialogDescription>
            {isMilestone && (
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-brand-50 border border-brand-500/40 text-brand-600 px-2 py-0.5 text-[11px] font-medium">
                <Flag className="h-3 w-3" />
                {item?.milestone === "job_start"
                  ? "Job Start milestone"
                  : "Substantial Completion milestone"}
              </span>
            )}
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {/* Kind toggle (create only) */}
          {mode === "create" && (
            <div className="flex gap-2">
              <button
                onClick={() => setKind("work")}
                className={cn(
                  "flex-1 rounded-md border p-3 text-left cursor-pointer",
                  kind === "work"
                    ? "border-brand-500 bg-brand-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">Work item</div>
                <div className="text-xs text-muted">
                  On-site work with start &amp; end dates
                </div>
              </button>
              <button
                onClick={() => setKind("todo")}
                className={cn(
                  "flex-1 rounded-md border p-3 text-left cursor-pointer",
                  kind === "todo"
                    ? "border-brand-500 bg-brand-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">To-do</div>
                <div className="text-xs text-muted">
                  Task with a due date, optional checklist
                </div>
              </button>
            </div>
          )}

          {/* Title & description */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Title" className="sm:col-span-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "work" ? "Electrical Rough-In" : "Schedule electrician"}
              />
            </Field>
            <Field label="Status">
              <Select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as Enums<"schedule_item_status">)
                }
              >
                <option value="not_started">Not started</option>
                <option value="in_progress">In progress</option>
                <option value="complete">Complete</option>
                <option value="delayed">Delayed</option>
              </Select>
            </Field>
            {kind === "work" ? (
              <>
                <Field label="Start date">
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => onChangeStartDate(e.target.value)}
                  />
                </Field>
                <Field
                  label="Duration (business days)"
                  hint="M–F only. Sets end date automatically."
                >
                  <Input
                    type="number"
                    min={0}
                    value={duration}
                    onChange={(e) => onChangeDuration(e.target.value)}
                    placeholder="e.g. 5"
                  />
                </Field>
                <Field label="End date">
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => onChangeEndDate(e.target.value)}
                  />
                </Field>
                {/* Predecessors sit right under the dates on purpose:
                    picking one rewrites Start date (onPredecessorAdded), so
                    cause and effect are adjacent. */}
                <div className="sm:col-span-2">
                  <PredecessorsEditor
                    value={predecessors}
                    onChange={setPredecessors}
                    items={itemsForPredecessors}
                    onAdd={onPredecessorAdded}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={excludeFromCritical}
                      onChange={(e) => setExcludeFromCritical(e.target.checked)}
                      className="h-4 w-4 mt-0.5"
                    />
                    <span>
                      Exclude from critical path
                      <span className="block text-muted">
                        For schedule markers like a completion target that
                        aren&apos;t real on-site work — keeps them off the
                        critical path and out of the project-finish
                        calculation.
                      </span>
                    </span>
                  </label>
                </div>
              </>
            ) : (
              <>
                <Field label="Priority">
                  <Select
                    value={priority}
                    onChange={(e) =>
                      setPriority(
                        e.target.value as Enums<"todo_priority"> | ""
                      )
                    }
                  >
                    <option value="">— (none)</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </Select>
                </Field>
                <Field label="Parent work item">
                  <Select
                    value={parentId}
                    onChange={(e) => {
                      const next = e.target.value
                      setParentId(next)
                      // Drop the anchor if the parent goes away — the
                      // server-side check constraint requires both.
                      if (!next) setAnchorEnabled(false)
                    }}
                  >
                    <option value="">— (unlinked)</option>
                    {workItemOptions.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={anchorEnabled ? "Linked due date" : "Due date"}
                >
                  {anchorEnabled ? (
                    <AnchoredDuePreview
                      parent={data.items.find((i) => i.id === parentId) ?? null}
                      anchor={anchor}
                      offsetDays={Number(anchorOffset) || 0}
                    />
                  ) : (
                    <Input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                    />
                  )}
                </Field>
                {parentId && (
                  <div className="sm:col-span-2 -mt-2 space-y-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={anchorEnabled}
                        onChange={(e) => setAnchorEnabled(e.target.checked)}
                        className="h-4 w-4"
                      />
                      Link due date to parent (auto-updates when parent
                      moves)
                    </label>
                    {anchorEnabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-[140px_120px_1fr] gap-2 items-end">
                        <Field label="Anchor">
                          <Select
                            value={anchor}
                            onChange={(e) =>
                              setAnchor(e.target.value as "start" | "end")
                            }
                          >
                            <option value="start">Parent start</option>
                            <option value="end">Parent end</option>
                          </Select>
                        </Field>
                        <Field label="Offset (days)">
                          <Input
                            type="number"
                            step={1}
                            value={anchorOffset}
                            onChange={(e) => setAnchorOffset(e.target.value)}
                          />
                        </Field>
                        {/* Hint lives in the third grid column, to the right of
                            the input rather than below it, so the Anchor and
                            Offset controls stay bottom-aligned (the below-hint
                            was making the Offset field taller). h-9 +
                            items-center matches the input height so the text
                            lines up with the field. */}
                        <p className="h-9 flex items-center text-xs text-muted leading-tight">
                          negative = before, positive = after
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <Field label="Description" className="sm:col-span-2">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </Field>
            <Field
              label="Template tags"
              className="sm:col-span-2"
              hint="Only matters on template projects. Comma-separated conditions, e.g. walkout, !walkout — this item is copied to a new project only when every tag matches the house attributes answered at creation. Leave blank to always copy."
            >
              <TemplateTagsInput
                value={templateTagsText}
                onChange={setTemplateTagsText}
                suggestions={tagSuggestions}
                placeholder="walkout, finished_basement"
              />
            </Field>
          </div>

          {/* Assignments */}
          <AssignmentsEditor
            assignments={assignments}
            onChange={handleAssignmentsChange}
            profiles={data.profiles}
            companies={data.companies}
            roles={data.roles}
            roleMembers={data.roleMembers}
          />

          {/* Checklist (todos only) */}
          {kind === "todo" && (
            <ChecklistEditor
              value={checklist}
              onChange={setChecklist}
              assignments={assignments}
              profiles={data.profiles}
              companies={data.companies}
              roles={data.roles}
              roleMembers={data.roleMembers}
            />
          )}

          {/* Attachments (todos only) — needs a persisted id so the upload
              can write a server-side join row; create mode just nudges
              the user to save first. */}
          {kind === "todo" &&
            (mode === "edit" && item ? (
              <AttachmentsEditor
                scheduleItemId={item.id}
                projectId={data.project_id}
                attachments={attachmentsState}
                onChange={setAttachmentsState}
              />
            ) : (
              <AttachmentsCreatePlaceholder />
            ))}

          {/* Recurrence (todos only) */}
          {kind === "todo" && (
            <RecurrenceEditor value={recurrence} onChange={setRecurrence} />
          )}

          {/* Text a sub (edit only) — picker reads from data.assignments
              (the persisted set) rather than the in-memory `assignments`
              state, so the user can't try to text a sub they've added to
              the form but not yet saved. The server-side assignment check
              would reject that anyway with a confusing error. */}
          {mode === "edit" && item && (
            <SendTextToSubSection
              scheduleItemId={item.id}
              readyDate={item.start_date ?? item.due_date ?? ""}
              projectAddress={data.project_address}
              persistedAssignments={data.assignments.filter(
                (a) => a.schedule_item_id === item.id
              )}
              companies={data.companies}
              roles={data.roles}
              roleMembers={data.roleMembers}
            />
          )}

          {/* Delay log (edit only) */}
          {mode === "edit" && item && (
            <div>
              <div className="flex items-center justify-between">
                <Label>Delay log</Label>
                <button
                  onClick={() => setShowDelay((v) => !v)}
                  className="text-xs text-brand-600 hover:underline cursor-pointer inline-flex items-center gap-1"
                >
                  <AlertTriangle className="h-3 w-3" />
                  Log a delay
                </button>
              </div>
              {item.kind === "work" && baselineSet && (
                <p className="mt-0.5 text-xs text-muted">
                  Moving this item&apos;s dates? Edit them above and Save —
                  you&apos;ll be asked for a reason automatically. Use the delay
                  log to record a delay you&apos;re absorbing without shifting
                  the dates.
                </p>
              )}
              {showDelay && (
                <DelayLogInline
                  itemId={item.id}
                  projectId={data.project_id}
                  reasons={data.delayReasons}
                  onLogged={() => {
                    setShowDelay(false)
                    router.refresh()
                  }}
                />
              )}
              {delays.length > 0 && (
                <ul className="mt-2 divide-y divide-border border border-border rounded-md text-sm">
                  {delays.map((d) => (
                    <li
                      key={d.id}
                      className="px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div>
                        <Badge tone="warning">
                          {d.delay_days}d ·{" "}
                          {delayReasonLabel(d.reason_category, data.delayReasons)}
                        </Badge>
                        {d.notes && (
                          <span className="ml-2 text-muted text-xs">
                            {d.notes}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted">
                        {formatDate(d.logged_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Comments (edit only) — staff and assigned trades; RLS enforces
              who can actually post. */}
          {mode === "edit" && item && (
            <CommentsThread
              comments={comments.map((c) => ({
                id: c.id,
                author_name: c.author_name,
                author_role:
                  data.profiles.find((p) => p.id === c.author_id)?.role ?? null,
                body: c.body,
                created_at: c.created_at,
              }))}
              meName={data.me_name}
              canPost
              placeholder={
                data.role === "trade"
                  ? "Question or note for the builder…"
                  : "Note for the sub / team…"
              }
              onPost={(body) =>
                postScheduleItemComment({
                  schedule_item_id: item.id,
                  project_id: data.project_id,
                  body,
                })
              }
            />
          )}
        </DialogBody>
        <DialogFooter>
          {mode === "edit" && item && !isMilestone && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleDelete}
              disabled={pending}
              className="mr-auto text-danger hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          {mode === "edit" && item && item.kind === "todo" && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleSaveAndCopy}
              disabled={pending}
              title="Saves your changes, then opens the copy dialog"
            >
              <Copy className="h-4 w-4" /> Copy to job
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
      {showCopy && item && (
        <CopyTodoDialog
          open={true}
          onClose={() => setShowCopy(false)}
          sourceItemId={item.id}
          currentProjectId={data.project_id}
        />
      )}
      {pendingReasonSave && item && (
        <MoveReasonDialog
          open={true}
          reasons={data.delayReasons}
          pending={pending}
          description={`${item.title}: ${formatDateRange(
            item.start_date,
            item.end_date
          )} → ${formatDateRange(
            effectiveDates(pendingReasonSave.payload).start,
            effectiveDates(pendingReasonSave.payload).end
          )}`}
          onConfirm={(reason: MoveReasonT) =>
            doSave(
              { ...pendingReasonSave.payload, move_reason: reason },
              pendingReasonSave.andCopy
            )
          }
          onCancel={() => setPendingReasonSave(null)}
        />
      )}
      {dependents && item && (
        <DeleteWithDependentsDialog
          open={true}
          onClose={() => setDependents(null)}
          onDeleted={() => {
            setDependents(null)
            router.refresh()
            onClose()
          }}
          itemId={item.id}
          itemTitle={item.title}
          projectId={data.project_id}
          dependents={dependents}
          candidatePredecessors={data.items.filter(
            (i) => i.kind === "work" && i.id !== item.id
          )}
        />
      )}
    </Dialog>
  )
}

function AssignmentsEditor({
  assignments,
  onChange,
  profiles,
  companies,
  roles,
  roleMembers,
}: {
  assignments: Assignment[]
  onChange: (v: Assignment[]) => void
  profiles: ScheduleData["profiles"]
  companies: ScheduleData["companies"]
  roles: ScheduleData["roles"]
  roleMembers: ScheduleData["roleMembers"]
}) {
  // Commit-on-select. Picking from either dropdown stages the assignment
  // immediately and the picker resets to its placeholder (value=""). The
  // previous "pick then click +" flow was easy to miss — users chose a
  // sub, hit Save, and the assignment was never staged, so it silently
  // vanished even though the item itself saved fine ("Saved" toast, no
  // sub). PredecessorsEditor was fixed the same way for the same reason.
  function addProfile(id: string) {
    if (!id) return
    if (assignments.some((a) => a.profile_id === id)) return
    onChange([...assignments, { profile_id: id }])
  }
  function addCompany(id: string) {
    if (!id) return
    if (assignments.some((a) => a.company_id === id)) return
    onChange([...assignments, { company_id: id }])
  }
  function addRole(id: string) {
    if (!id) return
    if (assignments.some((a) => a.role_id === id)) return
    onChange([...assignments, { role_id: id }])
  }
  function remove(i: number) {
    onChange(assignments.filter((_, idx) => idx !== i))
  }

  // Resolve a role assignment to "Role (Person)" using this project's role map.
  // Shared with the schedule list/Gantt views via the helper so the label
  // can't drift between the dialog chips and the rows.
  function roleLabel(roleId: string): string {
    return resolveRoleLabel(roleId, { profiles, companies, roles, roleMembers })
  }

  // Hide already-staged entries from the pickers (same as PredecessorsEditor's
  // `available`) so re-picking the same person/company isn't a no-op surprise.
  // Each list is sorted alphabetically so the pickers are easy to scan — the
  // roles catalog in particular arrives in manual `position` order, not A–Z.
  // filter()/[...spread] return fresh arrays, so the sort never mutates props.
  const availableProfiles = profiles
    .filter((p) => !assignments.some((a) => a.profile_id === p.id))
    .sort((a, b) =>
      (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "")
    )
  const availableCompanies = companies
    .filter(
      (c) => c.type !== "client" && !assignments.some((a) => a.company_id === c.id)
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  const availableRoles = roles
    .filter((r) => !assignments.some((a) => a.role_id === r.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div>
      <Label>Assignments</Label>
      <div className="mt-1 flex flex-wrap gap-1.5 min-h-8">
        {assignments.length === 0 && (
          <span className="text-xs text-muted">No one assigned yet</span>
        )}
        {assignments.map((a, i) => {
          // Role chips are tinted differently and show the resolved name so
          // staff see who the role currently maps to on this job.
          const isRole = !!a.role_id
          const label = a.profile_id
            ? profiles.find((p) => p.id === a.profile_id)?.full_name ??
              profiles.find((p) => p.id === a.profile_id)?.email ??
              "?"
            : a.company_id
              ? companies.find((c) => c.id === a.company_id)?.name ?? "?"
              : roleLabel(a.role_id!)
          return (
            <span
              key={`${a.profile_id ?? ""}-${a.company_id ?? ""}-${a.role_id ?? ""}`}
              className={cn(
                "inline-flex items-center gap-1 rounded-full text-xs px-2 py-0.5",
                isRole
                  ? "bg-amber-100 text-amber-900"
                  : "bg-brand-100 text-brand-700"
              )}
            >
              {label}
              <button
                type="button"
                aria-label={`Remove ${label}`}
                title={`Remove ${label}`}
                onClick={() => remove(i)}
                className={cn(
                  "rounded-full p-0.5 cursor-pointer",
                  isRole
                    ? "hover:bg-amber-500 hover:text-white"
                    : "hover:bg-brand-500 hover:text-white"
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
      </div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Select
          value=""
          onChange={(e) => addRole(e.target.value)}
          aria-label="Add a role"
        >
          <option value="">Add role…</option>
          {availableRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Select
          value=""
          onChange={(e) => addProfile(e.target.value)}
          aria-label="Add team member or user"
        >
          <option value="">Add team / user…</option>
          {availableProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.full_name || p.email) +
                ` · ${
                  p.role === "staff"
                    ? "Team"
                    : p.role === "trade"
                      ? "Sub"
                      : "Client"
                }`}
            </option>
          ))}
        </Select>
        <Select
          value=""
          onChange={(e) => addCompany(e.target.value)}
          aria-label="Add subcontractor or vendor"
        >
          <option value="">Add subcontractor / vendor…</option>
          {availableCompanies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.trade_category ? ` (${c.trade_category})` : ""}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-xs text-muted mt-1.5">
        Assign to a <span className="text-amber-900">role</span> (resolved per
        job in the Roles tab) or directly to a person or sub.
      </p>
    </div>
  )
}

function PredecessorsEditor({
  value,
  onChange,
  items,
  onAdd,
}: {
  value: PredEdit[]
  onChange: (v: PredEdit[]) => void
  items: Tables<"schedule_items">[]
  onAdd?: (p: PredEdit) => void
}) {
  // Commit-on-select. The previous "fill three fields then click +" flow
  // was easy to miss — users picked a predecessor, hit Save, and the row
  // was never staged. Now picking a work item from the dropdown adds it
  // immediately with sane defaults (FS / 0 lag); the type and lag can be
  // tweaked inline on the staged row.
  function add(predId: string) {
    if (!predId) return
    if (value.some((p) => p.predecessor_id === predId)) return
    const newPred: PredEdit = {
      predecessor_id: predId,
      dep_type: "FS",
      lag_days: 0,
    }
    onChange([...value, newPred])
    onAdd?.(newPred)
  }
  function update(idx: number, patch: Partial<PredEdit>) {
    const next = value.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    onChange(next)
    // Re-anchor the parent's start date whenever the relationship changes,
    // so flipping FS→SS or tweaking the lag updates the date the same way
    // adding the predecessor for the first time does.
    onAdd?.(next[idx])
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }

  // Sorted alphabetically by title so the "Choose work item…" picker is easy
  // to scan on jobs with a long schedule. filter() returns a fresh array, so
  // the sort doesn't mutate the caller's `items`.
  const available = items
    .filter((it) => !value.some((p) => p.predecessor_id === it.id))
    .sort((a, b) => a.title.localeCompare(b.title))

  return (
    <div>
      <Label>Predecessors</Label>
      {value.length > 0 && (
        <ul className="mt-1 border border-border rounded-md divide-y divide-border text-sm">
          {value.map((p, i) => {
            const target = items.find((x) => x.id === p.predecessor_id)
            return (
              <li
                key={p.predecessor_id}
                className="px-3 py-2 grid grid-cols-1 sm:grid-cols-[1fr_90px_90px_auto] gap-2 items-center"
              >
                <span>
                  After <strong>{target?.title ?? "?"}</strong>
                </span>
                <Select
                  value={p.dep_type}
                  onChange={(e) =>
                    update(i, {
                      dep_type: e.target.value as Enums<"dependency_type">,
                    })
                  }
                  aria-label="Dependency type"
                >
                  <option value="FS">FS</option>
                  <option value="SS">SS</option>
                  <option value="FF">FF</option>
                  <option value="SF">SF</option>
                </Select>
                <Input
                  type="number"
                  step={1}
                  value={p.lag_days}
                  onChange={(e) =>
                    update(i, { lag_days: Math.trunc(Number(e.target.value) || 0) })
                  }
                  aria-label="Lag (days)"
                  title="Lag (days)"
                />
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-muted hover:text-danger cursor-pointer p-1"
                  aria-label="Remove predecessor"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-2">
        <Field label="Add predecessor">
          <Select
            value=""
            onChange={(e) => {
              const v = e.target.value
              if (v) add(v)
              // The <select> is controlled with value="" so it always
              // shows the placeholder after a pick — no manual reset.
            }}
            disabled={available.length === 0}
          >
            <option value="">
              {available.length === 0
                ? "No other work items"
                : "Choose work item…"}
            </option>
            {available.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  )
}

function ChecklistEditor({
  value,
  onChange,
  assignments,
  profiles,
  companies,
  roles,
  roleMembers,
}: {
  value: ChecklistItem[]
  onChange: (v: ChecklistItem[]) => void
  assignments: Assignment[]
  profiles: ScheduleData["profiles"]
  companies: ScheduleData["companies"]
  roles: ScheduleData["roles"]
  roleMembers: ScheduleData["roleMembers"]
}) {
  // A single dropdown encodes all three kinds of assignee with a prefixed
  // value ("p:<id>" profile, "c:<id>" company, "r:<id>" role) so we can keep
  // the one-of-three shape the server expects.
  function setAssignee(idx: number, raw: string) {
    const next = [...value]
    const c = next[idx]
    next[idx] = {
      ...c,
      assignee_profile_id: raw.startsWith("p:") ? raw.slice(2) : null,
      assignee_company_id: raw.startsWith("c:") ? raw.slice(2) : null,
      assignee_role_id: raw.startsWith("r:") ? raw.slice(2) : null,
    }
    onChange(next)
  }

  function optionLabel(v: string): string {
    if (v.startsWith("p:")) {
      const p = profiles.find((x) => x.id === v.slice(2))
      return p?.full_name || p?.email || "?"
    }
    if (v.startsWith("c:")) {
      return companies.find((x) => x.id === v.slice(2))?.name ?? "?"
    }
    return resolveRoleLabel(v.slice(2), {
      profiles,
      companies,
      roles,
      roleMembers,
    })
  }

  // The picker only offers who's already assigned on this to-do — pick from
  // the short list instead of scrolling the full company directory. Add
  // someone under Assignments first to make them available here.
  const options = assignments
    .map((a) =>
      a.profile_id
        ? `p:${a.profile_id}`
        : a.company_id
          ? `c:${a.company_id}`
          : a.role_id
            ? `r:${a.role_id}`
            : ""
    )
    .filter(Boolean)
  // The to-do's sole assignee (if it has exactly one) — new checklist items
  // default to them, mirroring the server's sole-assignee rule.
  const sole = assignments.length === 1 ? assignments[0] : null

  return (
    <div>
      <Label>Checklist</Label>
      <ul className="mt-1 space-y-1.5">
        {value.map((c, i) => {
          const assigneeValue = c.assignee_profile_id
            ? `p:${c.assignee_profile_id}`
            : c.assignee_company_id
              ? `c:${c.assignee_company_id}`
              : c.assignee_role_id
                ? `r:${c.assignee_role_id}`
                : ""
          // A stored assignee that's no longer on the to-do still needs an
          // option, or the select would silently show the wrong value.
          const stale = assigneeValue !== "" && !options.includes(assigneeValue)
          return (
            <li key={i} className="flex items-center gap-2">
              <GripVertical className="h-3.5 w-3.5 text-muted shrink-0" />
              <input
                type="checkbox"
                checked={c.is_done}
                onChange={(e) => {
                  const next = [...value]
                  next[i] = { ...c, is_done: e.target.checked }
                  onChange(next)
                }}
                className="h-4 w-4 rounded border-border-strong shrink-0"
              />
              <Input
                value={c.label}
                onChange={(e) => {
                  const next = [...value]
                  next[i] = { ...c, label: e.target.value }
                  onChange(next)
                }}
                placeholder="Checklist item"
                className="flex-1 min-w-0"
              />
              <Select
                value={assigneeValue}
                onChange={(e) => setAssignee(i, e.target.value)}
                className="w-36 shrink-0 text-xs"
                aria-label="Assign checklist item"
                title="Offers the people already assigned on this to-do — add someone under Assignments to make them available here"
              >
                <option value="">Unassigned</option>
                {options.map((v) => (
                  <option key={v} value={v}>
                    {optionLabel(v)}
                  </option>
                ))}
                {stale && (
                  <option value={assigneeValue}>
                    {optionLabel(assigneeValue)} (not on this to-do)
                  </option>
                )}
              </Select>
              <button
                type="button"
                className="text-muted hover:text-danger p-1 cursor-pointer shrink-0"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...value,
            {
              label: "",
              is_done: false,
              assignee_profile_id: sole?.profile_id ?? null,
              assignee_company_id: sole?.company_id ?? null,
              assignee_role_id: sole?.role_id ?? null,
            },
          ])
        }
        className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add checklist item
      </button>
      <p className="mt-1.5 text-[11px] text-muted">
        The assignee list offers who&apos;s already on this to-do. When the
        to-do has exactly one assignee, all checklist items follow them
        automatically.
      </p>
    </div>
  )
}

function RecurrenceEditor({
  value,
  onChange,
}: {
  value: RecurrenceRule | null
  onChange: (v: RecurrenceRule | null) => void
}) {
  const enabled = !!value
  function update<K extends keyof RecurrenceRule>(
    key: K,
    v: RecurrenceRule[K]
  ) {
    onChange({ ...(value ?? { freq: "weekly" as RecurrenceFreq }), [key]: v })
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Recurring</Label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              onChange(e.target.checked ? { freq: "weekly" } : null)
            }
            className="h-4 w-4"
          />
          Enable recurrence
        </label>
      </div>
      {enabled && value && (
        <>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Field label="Frequency">
              <Select
                value={value.freq}
                onChange={(e) =>
                  update("freq", e.target.value as RecurrenceFreq)
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Bi-weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </Field>
            <Field label="Every">
              <Input
                type="number"
                min={1}
                value={value.interval ?? 1}
                onChange={(e) =>
                  update("interval", Math.max(1, Number(e.target.value) || 1))
                }
              />
            </Field>
            <Field label="Count (optional)">
              <Input
                type="number"
                min={1}
                value={value.count ?? ""}
                onChange={(e) =>
                  update(
                    "count",
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
              />
            </Field>
            <Field label="Until (optional)" className="sm:col-span-3">
              <Input
                type="date"
                value={value.until ?? ""}
                onChange={(e) =>
                  update("until", e.target.value || undefined)
                }
              />
            </Field>
            <Field label="Repeats from" className="sm:col-span-3">
              <Select
                value={value.anchor_mode ?? "fixed"}
                onChange={(e) =>
                  // Omit the key for the default so stored rules stay minimal
                  // (and byte-identical to pre-feature rules).
                  update(
                    "anchor_mode",
                    e.target.value === "after_completion"
                      ? "after_completion"
                      : undefined
                  )
                }
              >
                <option value="fixed">
                  Fixed schedule — cadence counts from the due date (e.g. every May 1)
                </option>
                <option value="after_completion">
                  After completion — next due = date completed + interval (e.g. filters 3 months after done)
                </option>
              </Select>
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted">
            {describeRecurrence(value)} ·{" "}
            {(value.anchor_mode ?? "fixed") === "after_completion"
              ? "The next occurrence comes due one interval after you actually complete this one."
              : "Repeats count from the due date: completing this to-do automatically creates the next occurrence."}
          </p>
        </>
      )}
    </div>
  )
}

function DelayLogInline({
  itemId,
  projectId,
  reasons,
  onLogged,
}: {
  itemId: string
  projectId: string
  reasons: DelayReason[]
  onLogged: () => void
}) {
  const [days, setDays] = useState(1)
  const [reason, setReason] = useState<string>(reasons[0]?.value ?? "other")
  const [notes, setNotes] = useState("")
  const [pushDates, setPushDates] = useState(true)
  const [pending, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      try {
        await logDelay({
          schedule_item_id: itemId,
          project_id: projectId,
          delay_days: days,
          reason_category: reason,
          notes: notes || undefined,
          push_dates: pushDates,
        })
        toast.success(
          pushDates ? "Delay logged and dates pushed" : "Delay logged"
        )
        onLogged()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not log delay")
      }
    })
  }

  return (
    <div className="mt-2 p-3 bg-amber-50/60 border border-amber-200 rounded-md grid grid-cols-1 sm:grid-cols-[80px_1fr_auto] gap-2 items-end">
      <Field label="Days">
        <Input
          type="number"
          min={0}
          value={days}
          onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
        />
      </Field>
      <Field label="Reason">
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Notes" className="sm:col-span-3">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <label className="sm:col-span-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={pushDates}
          onChange={(e) => setPushDates(e.target.checked)}
        />
        Push dates of this item (and cascade)
      </label>
      <Button type="button" onClick={submit} disabled={pending}>
        {pending ? "…" : "Log"}
      </Button>
    </div>
  )
}

function AnchoredDuePreview({
  parent,
  anchor,
  offsetDays,
}: {
  parent: Tables<"schedule_items"> | null
  anchor: "start" | "end"
  offsetDays: number
}) {
  if (!parent) {
    return (
      <div className="h-9 flex items-center text-xs text-muted px-1">
        Pick a parent to see the computed date.
      </div>
    )
  }
  const basis = anchor === "start" ? parent.start_date : parent.end_date
  if (!basis) {
    return (
      <div className="h-9 flex items-center text-xs text-muted px-1">
        Parent has no {anchor} date yet — due date will fill in once it does.
      </div>
    )
  }
  const computed = addDays(basis, offsetDays)
  return (
    <div className="h-9 flex items-center font-mono text-sm tabular-nums px-1">
      {formatDate(computed)}
    </div>
  )
}

function buildSubTextMessage(opts: {
  companyName: string
  projectAddress: string | null
  readyDate: string
}): string {
  const address = opts.projectAddress?.trim() || "[address not set]"
  // "Ready now" if today >= readyDate; otherwise "Ready by <date>". Build
  // today from the local clock — `toISOString()` returns UTC, which for
  // users west of UTC in the evening would flip the boundary a day early.
  const now = new Date()
  const today =
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")}`
  let status: string
  if (!opts.readyDate) {
    status = "ready now"
  } else if (opts.readyDate <= today) {
    status = "ready now"
  } else {
    status = `ready by ${formatDate(opts.readyDate)}`
  }
  return `Hi ${opts.companyName} — ${address} is ${status}. Let me know if you have any questions.`
}

type TextRecipient = {
  key: string
  label: string
  company: { id: string; name: string; phone: string | null }
  target: { kind: "company"; company_id: string } | { kind: "role"; role_id: string }
}

function SendTextToSubSection({
  scheduleItemId,
  readyDate,
  projectAddress,
  persistedAssignments,
  companies,
  roles,
  roleMembers,
}: {
  scheduleItemId: string
  readyDate: string
  projectAddress: string | null
  persistedAssignments: Tables<"schedule_assignments">[]
  companies: ScheduleData["companies"]
  roles: ScheduleData["roles"]
  roleMembers: ScheduleData["roleMembers"]
}) {
  // Textable recipients = subs/vendors reachable from this item's SAVED
  // assignments. A direct company assignment is textable as-is; a ROLE
  // assignment is textable when the role is filled by a company on this job
  // (resolved through roleMembers) — so "text whoever holds the role" works.
  // The server re-resolves and re-verifies everything; this list is just UX.
  const recipients: TextRecipient[] = []
  const seenCompanyIds = new Set<string>()
  let skippedRoles = 0
  // Direct company assignments first — they win the dedupe against a role
  // that resolves to the same company.
  for (const a of persistedAssignments) {
    if (!a.company_id) continue
    const c = companies.find((x) => x.id === a.company_id)
    if (!c || c.type === "client" || seenCompanyIds.has(c.id)) continue
    seenCompanyIds.add(c.id)
    recipients.push({
      key: `company:${c.id}`,
      label: c.name,
      company: { id: c.id, name: c.name, phone: c.phone },
      target: { kind: "company", company_id: c.id },
    })
  }
  // Role assignments resolved to the sub/vendor filling them on this job.
  for (const a of persistedAssignments) {
    if (!a.role_id) continue
    const member = roleMembers.find((m) => m.role_id === a.role_id)
    const c = member?.company_id
      ? companies.find((x) => x.id === member.company_id)
      : undefined
    if (!c || c.type === "client") {
      // Role is unfilled or filled by a staff member — no SMS target.
      skippedRoles++
      continue
    }
    if (seenCompanyIds.has(c.id)) continue
    seenCompanyIds.add(c.id)
    const roleName = roles.find((r) => r.id === a.role_id)?.name ?? "Role"
    recipients.push({
      key: `role:${a.role_id}`,
      label: `${c.name} · ${roleName}`,
      company: { id: c.id, name: c.name, phone: c.phone },
      target: { kind: "role", role_id: a.role_id },
    })
  }

  const [open, setOpen] = useState(false)
  const [recipientKey, setRecipientKey] = useState<string>(
    recipients[0]?.key ?? ""
  )
  const [message, setMessage] = useState("")
  const [pending, startTransition] = useTransition()

  // Keep the picker in sync if the user adds/removes assignees while the
  // dialog is open. Also reset the message whenever the picked recipient
  // changes so the preview reflects the new recipient name.
  const selected =
    recipients.find((r) => r.key === recipientKey) ?? recipients[0] ?? null

  function openPanel() {
    const r = selected ?? recipients[0]
    if (!r) return
    setRecipientKey(r.key)
    setMessage(
      buildSubTextMessage({
        companyName: r.company.name,
        projectAddress,
        readyDate,
      })
    )
    setOpen(true)
  }

  function pickRecipient(key: string) {
    setRecipientKey(key)
    const r = recipients.find((x) => x.key === key)
    if (r) {
      setMessage(
        buildSubTextMessage({
          companyName: r.company.name,
          projectAddress,
          readyDate,
        })
      )
    }
  }

  function send() {
    if (!selected) return
    if (!message.trim()) {
      toast.error("Message is empty")
      return
    }
    startTransition(async () => {
      try {
        const res = await sendQuoTextToSub({
          schedule_item_id: scheduleItemId,
          message: message.trim(),
          ...(selected.target.kind === "company"
            ? { company_id: selected.target.company_id }
            : { role_id: selected.target.role_id }),
        })
        if (res.ok) {
          toast.success(`Text sent to ${res.company_name}`)
          setOpen(false)
        } else {
          toast.error(res.error)
        }
      } catch (e) {
        // The action returns typed errors for user-facing failures, so a
        // thrown exception here means something unexpected (network drop,
        // auth redirect). Next.js masks the message in prod — give the
        // user a clear-ish fallback.
        console.error("sendQuoTextToSub threw:", e)
        toast.error("Couldn't send text. Try again, or check the server logs.")
      }
    })
  }

  if (recipients.length === 0) return null

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Notify sub</Label>
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          className="text-xs text-brand-600 hover:underline cursor-pointer inline-flex items-center gap-1"
        >
          <MessageSquare className="h-3 w-3" />
          {open ? "Cancel" : "Send text to sub"}
        </button>
      </div>
      {open && selected && (
        <div className="mt-2 p-3 bg-brand-50/60 border border-brand-200 rounded-md space-y-2">
          {recipients.length > 1 && (
            <Field label="Recipient">
              <Select
                value={recipientKey}
                onChange={(e) => pickRecipient(e.target.value)}
              >
                {recipients.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                    {r.company.phone ? "" : " (no phone on file)"}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!selected.company.phone && (
            <p className="text-xs text-danger">
              {selected.company.name} has no phone number on file. Add one on the
              company profile before sending.
            </p>
          )}
          <Field label="Message" hint={`${message.length} / 1600`}>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 1600))}
              rows={4}
            />
          </Field>
          {skippedRoles > 0 && (
            <p className="text-[11px] text-muted">
              {skippedRoles === 1 ? "1 role" : `${skippedRoles} roles`} on this
              item {skippedRoles === 1 ? "isn't" : "aren't"} filled by a
              sub/vendor, so {skippedRoles === 1 ? "it's" : "they're"} not
              listed.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={send}
              disabled={pending || !selected.company.phone}
            >
              {pending ? "Sending…" : "Send text"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
