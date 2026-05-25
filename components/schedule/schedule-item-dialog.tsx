"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  AlertTriangle,
  GripVertical,
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
  addBusinessDays,
  addDays,
  nextBusinessDay,
  businessDaysBetween,
  endDateFromDuration,
} from "@/lib/utils"
import {
  saveScheduleItem,
  deleteScheduleItem,
  logDelay,
  type ScheduleItemInputT,
} from "@/app/actions/schedule"
import type {
  RecurrenceRule,
  RecurrenceFreq,
} from "@/lib/schedule/recurrence"
import { isRecurrenceRule, describeRecurrence } from "@/lib/schedule/recurrence"
import type { Tables, Enums } from "@/lib/db/types"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"
import { checklistFor, predecessorsOf, delaysFor } from "./helpers"

type Mode = "create" | "edit"

type Assignment = { profile_id?: string | null; company_id?: string | null }
type ChecklistItem = { id?: string; label: string; is_done: boolean }
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
  // Called by PredecessorsEditor when a new predecessor is added — auto-fills
  // the start date to the next business day after the predecessor's end
  // (plus lag, for FS dependencies). Only fires if start date is currently
  // unset, so manual edits aren't clobbered.
  function onPredecessorAdded(p: { predecessor_id: string; dep_type: string; lag_days: number }) {
    if (startDate) return
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
    const lagApplied = addBusinessDays(basis, Math.max(p.lag_days, 0))
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
      }))
  })
  const [checklist, setChecklist] = useState<ChecklistItem[]>(() => {
    if (!item) return []
    return checklistFor(item.id, data.checklist).map((c) => ({
      id: c.id,
      label: c.label,
      is_done: c.is_done,
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

  const workItemOptions = data.items.filter(
    (i) => i.kind === "work" && i.id !== item?.id
  )
  const itemsForPredecessors = data.items.filter(
    (i) => i.kind === "work" && i.id !== item?.id
  )

  async function handleSave() {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    if (kind === "work" && startDate && endDate && endDate < startDate) {
      toast.error("End date must be on or after start date")
      return
    }
    const anchored = kind === "todo" && !!parentId && anchorEnabled
    const payload: ScheduleItemInputT = {
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
      parent_offset_days: anchored ? Number(anchorOffset) || 0 : null,
      status,
      recurrence_rule: kind === "todo" ? recurrence : null,
      assignments,
      checklist: kind === "todo" ? checklist : [],
      predecessors: kind === "work" ? predecessors : [],
    }
    startTransition(async () => {
      try {
        await saveScheduleItem(payload)
        toast.success(mode === "edit" ? "Saved" : "Created")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  async function handleDelete() {
    if (!item) return
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
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
              {kind === "work"
                ? "Primary on-site work with start/end dates."
                : "A task that may roll up under a work item."}
            </DialogDescription>
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
              </>
            ) : (
              <>
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
                        <Field
                          label="Offset (days)"
                          hint="negative = before, positive = after"
                        >
                          <Input
                            type="number"
                            value={anchorOffset}
                            onChange={(e) => setAnchorOffset(e.target.value)}
                          />
                        </Field>
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
          </div>

          {/* Assignments */}
          <AssignmentsEditor
            assignments={assignments}
            onChange={setAssignments}
            profiles={data.profiles}
            companies={data.companies}
          />

          {/* Predecessors (work only) */}
          {kind === "work" && (
            <PredecessorsEditor
              value={predecessors}
              onChange={setPredecessors}
              items={itemsForPredecessors}
              onAdd={onPredecessorAdded}
            />
          )}

          {/* Checklist (todos only) */}
          {kind === "todo" && (
            <ChecklistEditor value={checklist} onChange={setChecklist} />
          )}

          {/* Recurrence (todos only) */}
          {kind === "todo" && (
            <RecurrenceEditor value={recurrence} onChange={setRecurrence} />
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
              {showDelay && (
                <DelayLogInline
                  itemId={item.id}
                  projectId={data.project_id}
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
                          {d.delay_days}d · {d.reason_category}
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
        </DialogBody>
        <DialogFooter>
          {mode === "edit" && item && (
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
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignmentsEditor({
  assignments,
  onChange,
  profiles,
  companies,
}: {
  assignments: Assignment[]
  onChange: (v: Assignment[]) => void
  profiles: ScheduleData["profiles"]
  companies: ScheduleData["companies"]
}) {
  const [selProfile, setSelProfile] = useState("")
  const [selCompany, setSelCompany] = useState("")

  function addProfile() {
    if (!selProfile) return
    if (assignments.some((a) => a.profile_id === selProfile)) return
    onChange([...assignments, { profile_id: selProfile }])
    setSelProfile("")
  }
  function addCompany() {
    if (!selCompany) return
    if (assignments.some((a) => a.company_id === selCompany)) return
    onChange([...assignments, { company_id: selCompany }])
    setSelCompany("")
  }
  function remove(i: number) {
    onChange(assignments.filter((_, idx) => idx !== i))
  }

  return (
    <div>
      <Label>Assignments</Label>
      <div className="mt-1 flex flex-wrap gap-1.5 min-h-8">
        {assignments.length === 0 && (
          <span className="text-xs text-muted">No one assigned yet</span>
        )}
        {assignments.map((a, i) => {
          const label = a.profile_id
            ? profiles.find((p) => p.id === a.profile_id)?.full_name ??
              profiles.find((p) => p.id === a.profile_id)?.email ??
              "?"
            : companies.find((c) => c.id === a.company_id)?.name ?? "?"
          return (
            <span
              key={`${a.profile_id ?? ""}-${a.company_id ?? ""}`}
              className="inline-flex items-center gap-1 rounded-full bg-brand-100 text-brand-700 text-xs px-2 py-0.5"
            >
              {label}
              <button
                type="button"
                onClick={() => remove(i)}
                className="hover:bg-brand-500 hover:text-white rounded-full p-0.5 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
      </div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="flex gap-2">
          <Select
            value={selProfile}
            onChange={(e) => setSelProfile(e.target.value)}
          >
            <option value="">Add staff / user…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.full_name || p.email) + ` · ${p.role}`}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addProfile}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Select
            value={selCompany}
            onChange={(e) => setSelCompany(e.target.value)}
          >
            <option value="">Add subcontractor / vendor…</option>
            {companies
              .filter((c) => c.type !== "client")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.trade_category ? ` (${c.trade_category})` : ""}
                </option>
              ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addCompany}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
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
  const [sel, setSel] = useState("")
  const [dep, setDep] = useState<Enums<"dependency_type">>("FS")
  const [lag, setLag] = useState(0)
  function add() {
    if (!sel) return
    if (value.some((p) => p.predecessor_id === sel)) return
    const newPred: PredEdit = { predecessor_id: sel, dep_type: dep, lag_days: lag }
    onChange([...value, newPred])
    onAdd?.(newPred)
    setSel("")
    setDep("FS")
    setLag(0)
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }

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
                className="px-3 py-2 flex items-center justify-between gap-3"
              >
                <span>
                  After <strong>{target?.title ?? "?"}</strong>{" "}
                  <Badge tone="muted">{p.dep_type}</Badge>
                  {p.lag_days !== 0 && (
                    <span className="text-muted text-xs ml-1">
                      ({p.lag_days > 0 ? "+" : ""}
                      {p.lag_days}d lag)
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-muted hover:text-danger cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_100px_100px_auto] gap-2 items-end">
        <Field label="Add predecessor">
          <Select value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">Choose work item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select
            value={dep}
            onChange={(e) => setDep(e.target.value as Enums<"dependency_type">)}
          >
            <option value="FS">FS</option>
            <option value="SS">SS</option>
            <option value="FF">FF</option>
            <option value="SF">SF</option>
          </Select>
        </Field>
        <Field label="Lag (days)">
          <Input
            type="number"
            value={lag}
            onChange={(e) => setLag(Number(e.target.value) || 0)}
          />
        </Field>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ChecklistEditor({
  value,
  onChange,
}: {
  value: ChecklistItem[]
  onChange: (v: ChecklistItem[]) => void
}) {
  return (
    <div>
      <Label>Checklist</Label>
      <ul className="mt-1 space-y-1">
        {value.map((c, i) => (
          <li key={i} className="flex items-center gap-2">
            <GripVertical className="h-3.5 w-3.5 text-muted" />
            <input
              type="checkbox"
              checked={c.is_done}
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...c, is_done: e.target.checked }
                onChange(next)
              }}
              className="h-4 w-4 rounded border-border-strong"
            />
            <Input
              value={c.label}
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...c, label: e.target.value }
                onChange(next)
              }}
              placeholder="Checklist item"
              className="flex-1"
            />
            <button
              type="button"
              className="text-muted hover:text-danger p-1 cursor-pointer"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...value, { label: "", is_done: false }])}
        className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add checklist item
      </button>
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
          </div>
          <p className="mt-2 text-xs text-muted">
            {describeRecurrence(value)}
          </p>
        </>
      )}
    </div>
  )
}

function DelayLogInline({
  itemId,
  projectId,
  onLogged,
}: {
  itemId: string
  projectId: string
  onLogged: () => void
}) {
  const [days, setDays] = useState(1)
  const [reason, setReason] = useState<Enums<"delay_reason">>("weather")
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
        <Select
          value={reason}
          onChange={(e) => setReason(e.target.value as Enums<"delay_reason">)}
        >
          <option value="weather">Weather</option>
          <option value="sub">Subcontractor</option>
          <option value="material">Material</option>
          <option value="owner_decision">Owner decision</option>
          <option value="permit">Permit</option>
          <option value="other">Other</option>
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
