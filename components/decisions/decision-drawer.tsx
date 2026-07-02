"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  Send,
  Check,
  Upload,
  FileIcon,
  MessageSquare,
  Sparkles,
  Calculator,
  EyeOff,
  Palette,
  CheckCircle2,
  Circle,
  XCircle,
  RotateCcw,
  Copy,
  CalendarClock,
} from "lucide-react"
import { formatCurrency } from "@/lib/utils"
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
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { cn, formatDate, addDays } from "@/lib/utils"
import {
  saveDecision,
  deleteDecision,
  resetDecision,
  copyDecision,
  postComment,
  clientDecideDecision,
  type DecisionInputT,
} from "@/app/actions/decisions"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { formatTags, parseTagsInput } from "@/lib/template-tags"
import {
  KindChip,
  StatusBadge,
  CostDelta,
} from "@/app/(app)/projects/[id]/decisions/decisions-client"
import type { Tables, Enums } from "@/lib/db/types"
import type { DecisionsData } from "@/app/(app)/projects/[id]/decisions/decisions-client"

type Followup = {
  id?: string
  title: string
  kind: "todo" | "work"
  assignee_profile_id?: string | null
  assignee_company_id?: string | null
  due_offset_days: number
  duration_days?: number | null
  anchor_schedule_item_id?: string | null
  parent_anchor?: "start" | "end" | null
  parent_offset_days?: number | null
  notes?: string | null
}

type Attachment = {
  id?: string
  // For unsaved attachments on unsaved choices, this is "new:N" where N is
  // the choice's index in `choices`. For saved choices, it's the choice's
  // real UUID. null/undefined means decision-level (header gallery).
  choice_id?: string | null
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
  caption?: string | null
  preview_url?: string
}

type CostItem = {
  id?: string
  cost_code_id?: string | null
  description?: string | null
  quantity: number
  unit?: string | null
  unit_cost: number
}

type Choice = {
  id?: string
  // Stable key so attachments can reference this choice across re-renders
  // before it's persisted. For saved choices client_key === id.
  client_key: string
  title: string
  description?: string | null
  // In the allowance flow: absolute cost. Otherwise: contract delta.
  price_delta?: number | null
  // Per-choice cost breakdown (allowance flow only). Subtotal × the
  // decision-level markup_percent rolls up into the choice's effective cost.
  cost_items: CostItem[]
}

export function DecisionDrawer({
  open,
  onClose,
  mode,
  decision,
  defaultKind,
  data,
}: {
  open: boolean
  onClose: () => void
  mode: "create" | "edit"
  decision?: Tables<"decisions">
  defaultKind?: "change_order" | "selection"
  data: DecisionsData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)

  const initialKind: Enums<"decision_kind"> =
    decision?.kind ?? defaultKind ?? "change_order"

  const [kind, setKind] = useState<Enums<"decision_kind">>(initialKind)
  const [title, setTitle] = useState(decision?.title ?? "")
  const [description, setDescription] = useState(decision?.description ?? "")
  const [templateTagsText, setTemplateTagsText] = useState(
    formatTags(decision?.template_tags)
  )
  const [dueDate, setDueDate] = useState<string>(decision?.due_date ?? "")
  const [costDelta, setCostDelta] = useState<string>(() => {
    if (decision?.cost_delta == null) return ""
    // On change orders the stored cost_delta INCLUDES the delay cost
    // (delay_days × delay_cost_per_day). The manual field edits the base
    // price, so back the delay out; it's re-added on save and in the total
    // preview. Exactly recoverable — both factors live on the row.
    if (decision.kind === "change_order") {
      const storedDelay =
        (decision.delay_days ?? 0) * (Number(decision.delay_cost_per_day) || 0)
      const base = Math.round((Number(decision.cost_delta) - storedDelay) * 100) / 100
      return base === 0 ? "" : String(base)
    }
    return String(decision.cost_delta)
  })
  const [delayDays, setDelayDays] = useState<string>(
    decision?.delay_days != null ? String(decision.delay_days) : ""
  )
  const [delayCostPerDay, setDelayCostPerDay] = useState<string>(
    decision?.delay_cost_per_day != null ? String(decision.delay_cost_per_day) : ""
  )
  const [markupPercent, setMarkupPercent] = useState<string>(
    decision?.markup_percent != null && Number(decision.markup_percent) !== 0
      ? String(decision.markup_percent)
      : ""
  )
  const [costItems, setCostItems] = useState<CostItem[]>(() => {
    if (!decision) return []
    return data.cost_items
      // Only decision-level lines (per-choice rows hang off each choice).
      .filter((ci) => ci.decision_id === decision.id && !ci.choice_id)
      .map((ci) => ({
        id: ci.id,
        cost_code_id: ci.cost_code_id,
        description: ci.description,
        quantity: Number(ci.quantity),
        unit: ci.unit,
        unit_cost: Number(ci.unit_cost),
      }))
  })

  const effectiveCostItems = costItems.filter(
    (ci) => ci.cost_code_id || ci.description || ci.unit_cost > 0
  )
  const breakdownSubtotal = effectiveCostItems.reduce(
    (sum, ci) => sum + (Number(ci.quantity) || 0) * (Number(ci.unit_cost) || 0),
    0
  )
  const markupNum = markupPercent === "" ? 0 : Number(markupPercent) || 0
  const breakdownTotal = breakdownSubtotal * (1 + markupNum / 100)
  const hasBreakdown = effectiveCostItems.length > 0

  // Schedule impact (change orders only). The delay cost is part of the
  // client price: base (breakdown total or manual value) + days × $/day.
  const delayDaysNum = delayDays === "" ? null : Math.trunc(Number(delayDays))
  const delayCostPerDayNum =
    delayCostPerDay === "" ? null : Number(delayCostPerDay)
  const delayCost =
    kind === "change_order"
      ? (delayDaysNum ?? 0) * (delayCostPerDayNum ?? 0)
      : 0
  const changeOrderTotal =
    (hasBreakdown ? breakdownTotal : Number(costDelta) || 0) + delayCost

  const [status, setStatus] = useState<Enums<"decision_status">>(
    decision?.status ?? "draft"
  )
  const [followups, setFollowups] = useState<Followup[]>(() => {
    if (!decision) return []
    return data.followups
      .filter((f) => f.decision_id === decision.id)
      .map((f) => ({
        id: f.id,
        title: f.title,
        kind: f.kind,
        assignee_profile_id: f.assignee_profile_id,
        assignee_company_id: f.assignee_company_id,
        due_offset_days: f.due_offset_days,
        duration_days: f.duration_days,
        anchor_schedule_item_id: f.anchor_schedule_item_id,
        parent_anchor: f.parent_anchor,
        parent_offset_days: f.parent_offset_days,
        notes: f.notes,
      }))
  })
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    if (!decision) return []
    return data.attachments
      .filter((a) => a.decision_id === decision.id)
      .map((a) => ({
        id: a.id,
        choice_id: a.choice_id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
        preview_url: data.signed_urls[a.storage_path],
      }))
  })
  const [choices, setChoices] = useState<Choice[]>(() => {
    if (!decision) return []
    return data.choices
      .filter((c) => c.decision_id === decision.id)
      .map((c) => ({
        id: c.id,
        client_key: c.id,
        title: c.title,
        description: c.description,
        price_delta: c.price_delta,
        cost_items: data.cost_items
          .filter((ci) => ci.choice_id === c.id)
          .map((ci) => ({
            id: ci.id,
            cost_code_id: ci.cost_code_id,
            description: ci.description,
            quantity: Number(ci.quantity),
            unit: ci.unit,
            unit_cost: Number(ci.unit_cost),
          })),
      }))
  })
  const [allowanceAmount, setAllowanceAmount] = useState<string>(
    decision?.allowance_amount != null ? String(decision.allowance_amount) : ""
  )
  const [allowanceCostCodeId, setAllowanceCostCodeId] = useState<string>(
    decision?.allowance_cost_code_id ?? ""
  )
  const hasAllowance =
    kind === "selection" && allowanceAmount !== "" && !isNaN(Number(allowanceAmount))
  const allowanceNum = hasAllowance ? Number(allowanceAmount) : null
  // Mirror `choices` into a ref so the async upload callback can read the
  // latest list when it resolves — otherwise an upload kicked off before
  // the staff deletes a choice would re-append attachments referencing
  // that now-gone client_key.
  const choicesRef = useRef<Choice[]>(choices)
  useEffect(() => {
    choicesRef.current = choices
  }, [choices])
  // Client-only: which choice they've highlighted before clicking approve.
  // Defaults to whatever was previously selected (if re-opening an approved
  // selection), otherwise null.
  const [clientSelectedChoiceKey, setClientSelectedChoiceKey] = useState<
    string | null
  >(decision?.selected_choice_id ?? null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [copyOpen, setCopyOpen] = useState(false)

  const isClient = data.role === "client"
  const canEdit = data.role === "staff"
  const myComments = decision
    ? data.comments.filter((c) => c.decision_id === decision.id)
    : []

  // Decision-level attachments (header gallery) — exclude per-choice ones.
  const headerAttachments = attachments.filter((a) => !a.choice_id)

  function attachmentsForChoice(key: string): Attachment[] {
    return attachments.filter((a) => a.choice_id === key)
  }

  async function uploadFiles(
    files: FileList | null,
    choiceKey: string | null
  ) {
    if (!files?.length) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const newAtts: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${data.project_id}/decisions/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.${ext}`
        const { error } = await supabase.storage
          .from("project-files")
          .upload(path, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined,
          })
        if (error) {
          toast.error(`Upload failed: ${file.name} - ${error.message}`)
          continue
        }
        newAtts.push({
          choice_id: choiceKey,
          storage_path: path,
          file_name: file.name,
          file_type: file.type || null,
          file_size: file.size,
          preview_url: URL.createObjectURL(file),
        })
      }
      if (newAtts.length) {
        // If the user deleted the target choice while this upload was in
        // flight, drop the new attachments rather than re-attaching them
        // to a dead client_key. Storage blob is left orphaned for now —
        // same as the existing cascade pattern.
        const choiceStillExists =
          !choiceKey || choicesRef.current.some((c) => c.client_key === choiceKey)
        if (!choiceStillExists) {
          toast.info("Choice was removed — uploaded files discarded.")
        } else {
          // Functional setState so we don't clobber concurrent edits.
          setAttachments((current) => [...current, ...newAtts])
          toast.success(
            `${newAtts.length} file${newAtts.length === 1 ? "" : "s"} uploaded`
          )
        }
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function saveWithStatus(newStatus: Enums<"decision_status">) {
    handleSave(newStatus)
  }

  function handleSave(overrideStatus?: Enums<"decision_status">) {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    if (kind === "change_order") {
      if (
        delayDays.trim() === "" ||
        delayDaysNum == null ||
        isNaN(delayDaysNum) ||
        delayDaysNum < 0
      ) {
        toast.error("Enter the delay in days — required on change orders (0 for no delay).")
        return
      }
      if (
        delayDaysNum > 0 &&
        (delayCostPerDay.trim() === "" ||
          delayCostPerDayNum == null ||
          isNaN(delayCostPerDayNum) ||
          delayCostPerDayNum < 0)
      ) {
        toast.error("Enter the cost per day of delay.")
        return
      }
    }
    const payload: DecisionInputT = {
      id: decision?.id,
      project_id: data.project_id,
      kind,
      title: title.trim(),
      description: description || null,
      cost_delta:
        kind === "selection"
          ? null
          : hasBreakdown
          ? null
          : costDelta === ""
          ? null
          : Number(costDelta),
      markup_percent: markupNum,
      delay_days: kind === "change_order" ? delayDaysNum : null,
      delay_cost_per_day:
        kind === "change_order" && delayCostPerDayNum != null && !isNaN(delayCostPerDayNum)
          ? delayCostPerDayNum
          : null,
      cost_items: kind === "selection"
        ? []
        : effectiveCostItems.map((ci) => ({
            id: ci.id,
            cost_code_id: ci.cost_code_id || null,
            description: ci.description || null,
            quantity: ci.quantity,
            unit: ci.unit || null,
            unit_cost: ci.unit_cost,
          })),
      allowance_amount:
        kind === "selection" && allowanceAmount !== ""
          ? Number(allowanceAmount)
          : null,
      allowance_cost_code_id:
        kind === "selection" && allowanceCostCodeId && allowanceAmount !== ""
          ? allowanceCostCodeId
          : null,
      status: overrideStatus ?? status,
      due_date: dueDate || null,
      template_tags: parseTagsInput(templateTagsText),
      followups: followups
        .filter((f) => f.title.trim() !== "")
        .map((f) => {
          const anchored =
            !!f.anchor_schedule_item_id &&
            !!f.parent_anchor &&
            f.parent_offset_days != null
          return {
            id: f.id,
            title: f.title,
            kind: f.kind,
            assignee_profile_id: f.assignee_profile_id || null,
            assignee_company_id: f.assignee_company_id || null,
            due_offset_days: f.due_offset_days,
            duration_days:
              f.kind === "work" ? f.duration_days ?? 1 : null,
            anchor_schedule_item_id: anchored
              ? f.anchor_schedule_item_id
              : null,
            parent_anchor: anchored ? f.parent_anchor : null,
            parent_offset_days: anchored ? f.parent_offset_days : null,
            notes: f.notes,
          }
        }),
      attachments: attachments.map((a) => ({
        id: a.id,
        choice_id: a.choice_id ?? null,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
      })),
      choices:
        kind === "selection"
          ? choices
              .filter((c) => c.title.trim() !== "")
              .map((c) => ({
                id: c.id,
                client_key: c.client_key,
                title: c.title.trim(),
                description: c.description ?? null,
                price_delta:
                  c.price_delta == null || (c.price_delta as unknown) === ""
                    ? null
                    : Number(c.price_delta),
                cost_items: (c.cost_items ?? [])
                  .filter(
                    (ci) =>
                      ci.cost_code_id ||
                      ci.description ||
                      (ci.unit_cost ?? 0) > 0
                  )
                  .map((ci) => ({
                    id: ci.id,
                    cost_code_id: ci.cost_code_id || null,
                    description: ci.description || null,
                    quantity: ci.quantity,
                    unit: ci.unit || null,
                    unit_cost: ci.unit_cost,
                  })),
              }))
          : [],
    }
    startTransition(async () => {
      try {
        const result = await saveDecision(payload)
        setStatus(payload.status)
        if (result.createdFollowups > 0) {
          toast.success(
            `Approved · ${result.createdFollowups} follow-up to-do${
              result.createdFollowups === 1 ? "" : "s"
            } created`
          )
        } else {
          toast.success(mode === "edit" ? "Saved" : "Created")
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  function handleDelete() {
    if (!decision) return
    if (!confirm("Delete this decision and all its comments / files?")) return
    startTransition(async () => {
      try {
        await deleteDecision({ id: decision.id, project_id: data.project_id })
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  function handleReset() {
    if (!decision) return
    if (
      !confirm(
        "Reset this approved item back to draft? Follow-up to-dos and work items it created on the schedule will be removed, and the client's choice (for selections) will be cleared."
      )
    )
      return
    startTransition(async () => {
      try {
        await resetDecision({ id: decision.id, project_id: data.project_id })
        setStatus("draft")
        toast.success("Reset to draft")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Reset failed")
      }
    })
  }

  function handleCopy(targetProjectId: string) {
    if (!decision) return
    startTransition(async () => {
      try {
        const r = await copyDecision({
          id: decision.id,
          target_project_id: targetProjectId,
        })
        const targetProject = data.projects.find(
          (p) => p.id === targetProjectId
        )
        toast.success(
          r.sameProject
            ? "Copied — new draft created in this project"
            : `Copied to ${
                targetProject?.project_number ?? "the selected project"
              }`
        )
        router.refresh()
        // Navigate to the copy's project so the new draft is visible.
        if (!r.sameProject) {
          router.push(`/projects/${targetProjectId}/decisions`)
        }
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Copy failed")
      }
    })
  }

  function handleClientDecide(action: "approve" | "decline") {
    if (!decision) return
    if (action === "approve" && kind === "selection") {
      if (!clientSelectedChoiceKey) {
        toast.error("Pick a choice first")
        return
      }
    }
    const confirmMsg =
      action === "approve"
        ? kind === "selection"
          ? "Confirm this choice? This will approve the selection."
          : "Approve this change order?"
        : "Decline this item? The builder will be notified."
    if (!confirm(confirmMsg)) return
    startTransition(async () => {
      try {
        const r = await clientDecideDecision({
          decision_id: decision.id,
          project_id: data.project_id,
          action,
          choice_id:
            action === "approve" && kind === "selection"
              ? clientSelectedChoiceKey
              : null,
        })
        toast.success(
          r.status === "approved"
            ? "Approved — thanks!"
            : "Declined — sent back to builder"
        )
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not submit")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <div className="flex items-center gap-2 mb-1">
              {decision && (
                <span className="text-xs font-mono text-muted">
                  #{decision.number}
                </span>
              )}
              <KindChip kind={kind} />
              <StatusBadge status={status} />
              {dueDate && (
                <span className="text-xs text-muted">
                  Due {formatDate(dueDate)}
                </span>
              )}
            </div>
            <DialogTitle>
              {mode === "edit" ? decision?.title : "New " + (kind === "change_order" ? "change order" : "selection")}
            </DialogTitle>
            <DialogDescription>
              {kind === "change_order"
                ? "Changes to scope or cost that need owner approval."
                : "Selections the owner needs to make (paint, fixtures, finishes)."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {canEdit && mode === "create" && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setKind("change_order")}
                className={cn(
                  "rounded-md border p-3 text-left cursor-pointer",
                  kind === "change_order"
                    ? "border-amber-500 bg-amber-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">Change order</div>
                <div className="text-xs text-muted">Scope or cost change</div>
              </button>
              <button
                onClick={() => setKind("selection")}
                className={cn(
                  "rounded-md border p-3 text-left cursor-pointer",
                  kind === "selection"
                    ? "border-blue-500 bg-blue-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">Selection</div>
                <div className="text-xs text-muted">Paint, fixtures, finishes</div>
              </button>
            </div>
          )}

          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canEdit}
              placeholder={kind === "change_order" ? "Move powder room wall" : "Master bath floor tile"}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Due date"
              hint={
                canEdit
                  ? "Optional. Shown to the owner so they know when to respond."
                  : "Builder is asking for a response by this date."
              }
            >
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={!canEdit}
              />
            </Field>
          </div>
          {canEdit && kind === "selection" && (
            <AllowanceEditor
              amount={allowanceAmount}
              onAmountChange={setAllowanceAmount}
              costCodeId={allowanceCostCodeId}
              onCostCodeChange={setAllowanceCostCodeId}
              costCodes={data.cost_codes}
            />
          )}
          {canEdit && kind === "change_order" && (
            <CostBreakdownEditor
              items={costItems}
              onChange={setCostItems}
              costCodes={data.cost_codes}
              markupPercent={markupPercent}
              onMarkupChange={setMarkupPercent}
              subtotal={breakdownSubtotal}
              total={breakdownTotal}
            />
          )}
          {canEdit && kind === "selection" && (
            <Field
              label="Markup %"
              hint="Applied to each choice's cost breakdown. Hidden from clients."
            >
              <Input
                type="number"
                step="0.01"
                value={markupPercent}
                onChange={(e) => setMarkupPercent(e.target.value)}
                placeholder="0"
                className="w-32 text-right tabular-nums"
              />
            </Field>
          )}
          {/* Manual single-cost mode — change orders only. Selections capture
              cost per choice. */}
          {canEdit && !hasBreakdown && kind === "change_order" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Client price (no breakdown)"
                hint="Used when you don't itemize the cost. Positive adds to contract, negative is a credit. Delay cost is added on top."
              >
                <Input
                  type="number"
                  step="0.01"
                  value={costDelta}
                  onChange={(e) => setCostDelta(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Preview (before delay)">
                <div className="h-9 flex items-center font-mono text-sm">
                  <CostDelta value={costDelta === "" ? null : Number(costDelta)} />
                </div>
              </Field>
            </div>
          )}
          {/* Schedule impact — required on every change order. days × $/day is
              folded into the client price on save. */}
          {canEdit && kind === "change_order" && (
            <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  <CalendarClock className="inline h-3 w-3 mr-1 text-brand-500" />
                  Schedule delay
                </Label>
                <span className="text-[11px] text-muted">
                  Shown to the client and included in the price
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label="Delay (days) — required"
                  hint="Days this change adds to the schedule if approved by the due date. Enter 0 for no delay."
                >
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={delayDays}
                    onChange={(e) => setDelayDays(e.target.value)}
                    placeholder="0"
                    className="text-right tabular-nums"
                  />
                </Field>
                <Field
                  label="Cost per day"
                  hint="Charged for each day of delay."
                >
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={delayCostPerDay}
                    onChange={(e) => setDelayCostPerDay(e.target.value)}
                    placeholder="0.00"
                    className="text-right tabular-nums"
                  />
                </Field>
              </div>
              <div className="border-t border-border pt-2 space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">
                    Delay cost ({delayDaysNum ?? 0} day
                    {(delayDaysNum ?? 0) === 1 ? "" : "s"} ×{" "}
                    {formatCurrency(delayCostPerDayNum ?? 0)})
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(delayCost)}
                  </span>
                </div>
                <div className="flex items-center justify-between font-semibold border-t border-border pt-1.5">
                  <span>Client price (with delay)</span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(changeOrderTotal)}
                  </span>
                </div>
              </div>
            </div>
          )}
          {/* Client view: one all-in price (cost_delta already includes the
              delay cost) plus the quoted schedule impact. */}
          {!canEdit && kind === "change_order" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Price"
                hint="Positive adds to contract, negative is a credit."
              >
                <div className="h-9 flex items-center font-mono text-sm">
                  <CostDelta value={decision?.cost_delta ?? null} />
                </div>
              </Field>
              {decision?.delay_days != null && (
                <Field
                  label="Schedule delay"
                  hint={
                    decision.delay_days > 0
                      ? "If approved by the due date. Included in the price."
                      : undefined
                  }
                >
                  <div className="h-9 flex items-center gap-1.5 text-sm">
                    <CalendarClock className="h-3.5 w-3.5 text-brand-500 shrink-0" />
                    {decision.delay_days > 0 ? (
                      <span>
                        {decision.delay_days} day
                        {decision.delay_days === 1 ? "" : "s"} ×{" "}
                        {formatCurrency(Number(decision.delay_cost_per_day) || 0)}
                        /day ={" "}
                        <span className="font-mono tabular-nums">
                          {formatCurrency(
                            decision.delay_days *
                              (Number(decision.delay_cost_per_day) || 0)
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </div>
                </Field>
              )}
            </div>
          )}
          <Field label="Description / scope">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              rows={4}
              placeholder="What's changing or being selected, and any relevant detail for the owner."
            />
          </Field>
          {canEdit && (
            <Field
              label="Template tags"
              hint="Only matters on template projects. Comma-separated conditions, e.g. walkout, !walkout — this decision is copied to a new project only when every tag matches the house attributes answered at creation. Leave blank to always copy."
            >
              <Input
                value={templateTagsText}
                onChange={(e) => setTemplateTagsText(e.target.value)}
                placeholder="walkout, finished_basement"
              />
            </Field>
          )}

          {/* Selection choices — staff editor / client picker */}
          {kind === "selection" && (
            canEdit ? (
              <ChoicesEditor
                value={choices}
                onChange={setChoices}
                attachmentsForChoice={attachmentsForChoice}
                onAddPhotos={(files, choiceKey) =>
                  uploadFiles(files, choiceKey)
                }
                onRemoveAttachment={(att) =>
                  setAttachments((current) =>
                    current.filter(
                      (x) => x.storage_path !== att.storage_path
                    )
                  )
                }
                onRemoveChoice={(key) => {
                  // Prune the choice AND any photos that were attached to it
                  // so we don't ship dangling attachments to the server.
                  // Functional updates so a concurrent upload finishing in
                  // the same tick can't reintroduce them via stale closure.
                  setChoices((current) =>
                    current.filter((c) => c.client_key !== key)
                  )
                  setAttachments((current) =>
                    current.filter((a) => a.choice_id !== key)
                  )
                }}
                uploading={uploading}
                selectedChoiceId={decision?.selected_choice_id ?? null}
                allowance={allowanceNum}
                markupPercent={markupNum}
                costCodes={data.cost_codes}
              />
            ) : (
              <ClientChoicePicker
                choices={choices}
                attachmentsForChoice={attachmentsForChoice}
                selected={clientSelectedChoiceKey}
                onSelect={setClientSelectedChoiceKey}
                locked={status === "approved" || status === "rejected"}
                approvedChoiceId={decision?.selected_choice_id ?? null}
                allowance={allowanceNum}
                allowanceCostCode={
                  decision?.allowance_cost_code_id
                    ? data.cost_codes.find(
                        (c) => c.id === decision.allowance_cost_code_id
                      ) ?? null
                    : null
                }
              />
            )
          )}

          {/* Attachments — header gallery (decision-level only) */}
          <div>
            <Label>
              {kind === "selection"
                ? "Reference photos & files"
                : "Photos & files"}
            </Label>
            {canEdit && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => uploadFiles(e.target.files, null)}
              />
            )}
            <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {headerAttachments.map((a) => (
                <AttachmentTile
                  key={a.storage_path}
                  att={a}
                  canEdit={canEdit}
                  onRemove={() =>
                    setAttachments((current) =>
                      current.filter(
                        (x) => x.storage_path !== a.storage_path
                      )
                    )
                  }
                  onCaption={(c) =>
                    setAttachments((current) =>
                      current.map((x) =>
                        x.storage_path === a.storage_path
                          ? { ...x, caption: c }
                          : x
                      )
                    )
                  }
                />
              ))}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="aspect-square rounded-md border border-dashed border-border-strong flex flex-col items-center justify-center text-muted hover:border-brand-500 hover:text-brand-600 cursor-pointer text-xs gap-1 disabled:opacity-50"
                >
                  <Upload className="h-5 w-5" />
                  {uploading ? "Uploading…" : "Add files"}
                </button>
              )}
            </div>
          </div>

          {/* Follow-ups (staff only) */}
          {canEdit && (
            <FollowupsEditor
              value={followups}
              onChange={setFollowups}
              profiles={data.profiles}
              companies={data.companies}
              workItems={data.work_items}
              alreadyApproved={status === "approved"}
            />
          )}

          {/* Comments */}
          <CommentsThread
            decisionId={decision?.id}
            projectId={data.project_id}
            comments={myComments}
            profiles={data.profiles}
            meName={data.me_name}
            canPost={!!decision && (canEdit || isClient)}
            isClient={isClient}
          />
        </DialogBody>
        {canEdit && copyOpen && decision && (
          <CopyDecisionFooter
            projects={data.projects}
            currentProjectId={data.project_id}
            pending={pending}
            onCancel={() => setCopyOpen(false)}
            onCopy={handleCopy}
          />
        )}
        {canEdit && !copyOpen && (
          <DialogFooter>
            {mode === "edit" && decision && (
              <div className="mr-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDelete}
                  disabled={pending}
                  className="text-danger hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCopyOpen(true)}
                  disabled={pending}
                >
                  <Copy className="h-4 w-4" /> Copy
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {status === "approved" && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleReset}
                disabled={pending}
              >
                <RotateCcw className="h-4 w-4" /> Reset to draft
              </Button>
            )}
            {status !== "approved" && status !== "rejected" && (
              <>
                {status === "draft" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => saveWithStatus("pending_client")}
                    disabled={pending || uploading}
                  >
                    <Send className="h-4 w-4" /> Send to client
                  </Button>
                )}
                {status === "pending_client" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => saveWithStatus("rejected")}
                    disabled={pending || uploading}
                    className="text-danger"
                  >
                    Mark rejected
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => saveWithStatus("approved")}
                  disabled={pending || uploading}
                >
                  <Check className="h-4 w-4" />
                  Approve
                  {followups.length > 0
                    ? ` & create ${followups.length} follow-up${
                        followups.length === 1 ? "" : "s"
                      }`
                    : ""}
                </Button>
              </>
            )}
            <Button
              type="button"
              variant={status === "approved" ? "secondary" : "primary"}
              onClick={() => handleSave()}
              disabled={pending || uploading}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
        {/* Client-side decide footer: visible only while pending_client. */}
        {isClient && decision && status === "pending_client" && (
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleClientDecide("decline")}
              disabled={pending}
              className="text-danger"
            >
              <XCircle className="h-4 w-4" /> Decline
            </Button>
            <Button
              type="button"
              onClick={() => handleClientDecide("approve")}
              disabled={
                pending ||
                (kind === "selection" && !clientSelectedChoiceKey)
              }
            >
              <Check className="h-4 w-4" />
              {kind === "selection" ? "Confirm choice" : "Approve"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ChoicesEditor({
  value,
  onChange,
  attachmentsForChoice,
  onAddPhotos,
  onRemoveAttachment,
  onRemoveChoice,
  uploading,
  selectedChoiceId,
  allowance,
  markupPercent,
  costCodes,
}: {
  value: Choice[]
  onChange: (v: Choice[]) => void
  attachmentsForChoice: (key: string) => Attachment[]
  onAddPhotos: (files: FileList | null, choiceKey: string) => void
  onRemoveAttachment: (att: Attachment) => void
  // Removing a choice has to also drop its per-choice photos from
  // `attachments` state, otherwise we'd ship orphaned attachment rows
  // referencing a key the server can't resolve. Lifted into the parent.
  onRemoveChoice: (key: string) => void
  uploading: boolean
  selectedChoiceId: string | null
  // When non-null we're in the allowance flow: per-choice prices become
  // absolute costs and we surface a variance preview against this amount.
  allowance: number | null
  markupPercent: number
  costCodes: DecisionsData["cost_codes"]
}) {
  const hasAllowance = allowance != null
  function add() {
    onChange([
      ...value,
      {
        client_key: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: "",
        description: "",
        price_delta: null,
        cost_items: [],
      },
    ])
  }
  function update(key: string, patch: Partial<Choice>) {
    onChange(value.map((c) => (c.client_key === key ? { ...c, ...patch } : c)))
  }
  // Per-choice effective price (cost_items × markup → falls back to manual).
  function effectivePrice(c: Choice): number | null {
    const items = c.cost_items.filter(
      (ci) => ci.cost_code_id || ci.description || (ci.unit_cost ?? 0) > 0
    )
    if (items.length === 0) return c.price_delta ?? null
    const sub = items.reduce(
      (s, ci) => s + (Number(ci.quantity) || 0) * (Number(ci.unit_cost) || 0),
      0
    )
    return Math.round(sub * (1 + markupPercent / 100) * 100) / 100
  }

  return (
    <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <Label>
          <Palette className="inline h-3 w-3 mr-1 text-blue-500" />
          Choices &amp; per-choice cost
        </Label>
        <span className="text-[11px] text-muted">
          {hasAllowance
            ? "Variance from the allowance flows to billing on approval."
            : "Pre-load options — the owner picks one and its cost flows to billing."}
        </span>
      </div>
      {value.length === 0 && (
        <p className="text-xs text-muted">
          No choices yet. Add at least one before sending to the client.
        </p>
      )}
      <ul className="space-y-3">
        {value.map((c, i) => {
          const photos = attachmentsForChoice(c.client_key)
          const isSelected = !!(c.id && selectedChoiceId && c.id === selectedChoiceId)
          const price = effectivePrice(c)
          const variance =
            hasAllowance && price != null ? price - (allowance ?? 0) : null
          // Only count meaningful (non-blank) rows so empty placeholders
          // don't silently lock the manual price input.
          const hasItems = c.cost_items.some(
            (ci) =>
              ci.cost_code_id ||
              ci.description ||
              (ci.unit_cost ?? 0) > 0
          )
          return (
            <li
              key={c.client_key}
              className={cn(
                "rounded-md border bg-surface p-3 space-y-2",
                isSelected
                  ? "border-green-500 ring-1 ring-green-500/20"
                  : "border-border"
              )}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs font-mono text-muted mt-2.5 w-5 text-right">
                  {String.fromCharCode(65 + i)}.
                </span>
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2">
                  <Input
                    value={c.title}
                    onChange={(e) =>
                      update(c.client_key, { title: e.target.value })
                    }
                    placeholder="Choice name (e.g. Bianco Carrara)"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    value={
                      hasItems
                        ? price ?? ""
                        : c.price_delta ?? ""
                    }
                    disabled={hasItems}
                    onChange={(e) =>
                      update(c.client_key, {
                        price_delta:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    placeholder={hasAllowance ? "Cost" : "Price (optional)"}
                    title={
                      hasItems
                        ? "Auto-calculated from the breakdown below"
                        : undefined
                    }
                  />
                </div>
                {isSelected && (
                  <Badge tone="success" className="mt-1.5">
                    <CheckCircle2 className="h-3 w-3" /> Picked
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveChoice(c.client_key)}
                  className="text-muted hover:text-danger p-1 mt-1.5 cursor-pointer"
                  aria-label="Remove choice"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {hasAllowance && variance != null && (
                <div className="pl-7 text-[11px] font-mono tabular-nums">
                  {variance > 0 ? (
                    <span className="text-foreground">
                      Client pays{" "}
                      <span className="text-danger">
                        {formatCurrency(variance)}
                      </span>
                    </span>
                  ) : variance < 0 ? (
                    <span className="text-success">
                      Credit {formatCurrency(Math.abs(variance))}
                    </span>
                  ) : (
                    <span className="text-muted">At allowance — no charge</span>
                  )}
                </div>
              )}
              <Textarea
                rows={2}
                value={c.description ?? ""}
                onChange={(e) =>
                  update(c.client_key, { description: e.target.value })
                }
                placeholder="Short description shown to the client"
              />
              <ChoiceCostBreakdownEditor
                items={c.cost_items}
                onChange={(items) => update(c.client_key, { cost_items: items })}
                costCodes={costCodes}
              />
              <ChoicePhotosRow
                photos={photos}
                onAdd={(files) => onAddPhotos(files, c.client_key)}
                onRemove={onRemoveAttachment}
                uploading={uploading}
              />
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={add}
        className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add choice
      </button>
    </div>
  )
}

function ChoiceCostBreakdownEditor({
  items,
  onChange,
  costCodes,
}: {
  items: CostItem[]
  onChange: (v: CostItem[]) => void
  costCodes: DecisionsData["cost_codes"]
}) {
  const subtotal = items.reduce(
    (s, ci) => s + (Number(ci.quantity) || 0) * (Number(ci.unit_cost) || 0),
    0
  )
  function add() {
    onChange([
      ...items,
      {
        cost_code_id: null,
        description: "",
        quantity: 1,
        unit: null,
        unit_cost: 0,
      },
    ])
  }
  function update(i: number, patch: Partial<CostItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }
  return (
    <div className="rounded border border-border bg-background/40 p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted inline-flex items-center gap-1">
          <Calculator className="h-3 w-3 text-brand-500" />
          Cost breakdown
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted">
          <EyeOff className="h-3 w-3" /> internal
        </span>
      </div>
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left font-medium pb-1 w-[30%]">Cost code</th>
                <th className="text-left font-medium pb-1">Description</th>
                <th className="text-right font-medium pb-1 w-16">Qty</th>
                <th className="text-left font-medium pb-1 w-14">Unit</th>
                <th className="text-right font-medium pb-1 w-24">Unit cost</th>
                <th className="text-right font-medium pb-1 w-24">Line</th>
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((ci, i) => {
                const lineTotal = (ci.quantity || 0) * (ci.unit_cost || 0)
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-1 pb-1">
                      <Select
                        value={ci.cost_code_id ?? ""}
                        onChange={(e) =>
                          update(i, { cost_code_id: e.target.value || null })
                        }
                      >
                        <option value="">— Select —</option>
                        {costCodes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="pr-1 pb-1">
                      <Input
                        value={ci.description ?? ""}
                        onChange={(e) =>
                          update(i, { description: e.target.value })
                        }
                        placeholder="Detail"
                      />
                    </td>
                    <td className="pr-1 pb-1">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={ci.quantity}
                        onChange={(e) =>
                          update(i, { quantity: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="pr-1 pb-1">
                      <Input
                        value={ci.unit ?? ""}
                        onChange={(e) => update(i, { unit: e.target.value })}
                        placeholder="ea"
                      />
                    </td>
                    <td className="pr-1 pb-1">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={ci.unit_cost}
                        onChange={(e) =>
                          update(i, { unit_cost: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="pr-1 pb-1 text-right font-mono tabular-nums pt-2">
                      {formatCurrency(lineTotal)}
                    </td>
                    <td className="pb-1 pt-2">
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="text-muted hover:text-danger p-1 cursor-pointer"
                        aria-label="Remove line"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={add}
          className="text-[11px] text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
        >
          <Plus className="h-3 w-3" /> Add line
        </button>
        {items.length > 0 && (
          <span className="text-[11px] font-mono tabular-nums text-muted">
            Subtotal {formatCurrency(subtotal)}
          </span>
        )}
      </div>
    </div>
  )
}

function AllowanceEditor({
  amount,
  onAmountChange,
  costCodeId,
  onCostCodeChange,
  costCodes,
}: {
  amount: string
  onAmountChange: (v: string) => void
  costCodeId: string
  onCostCodeChange: (v: string) => void
  costCodes: DecisionsData["cost_codes"]
}) {
  const hasAmount = amount !== "" && !isNaN(Number(amount))
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          <Calculator className="inline h-3 w-3 mr-1 text-blue-600" />
          Allowance (optional)
        </Label>
        {hasAmount && (
          <button
            type="button"
            onClick={() => {
              onAmountChange("")
              onCostCodeChange("")
            }}
            className="text-[11px] text-muted hover:text-danger cursor-pointer"
          >
            Clear allowance
          </button>
        )}
      </div>
      <p className="text-xs text-muted">
        Budgeted amount already included in the contract. When set, each
        choice&apos;s cost becomes absolute and only the variance flows into
        billing.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-2">
        <Input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder="2,000.00"
          className="tabular-nums"
        />
        <Select
          value={costCodeId}
          onChange={(e) => onCostCodeChange(e.target.value)}
          disabled={!hasAmount}
        >
          <option value="">— Cost code (optional) —</option>
          {costCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}

function ChoicePhotosRow({
  photos,
  onAdd,
  onRemove,
  uploading,
}: {
  photos: Attachment[]
  onAdd: (files: FileList | null) => void
  onRemove: (att: Attachment) => void
  uploading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          onAdd(e.target.files)
          if (inputRef.current) inputRef.current.value = ""
        }}
      />
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
        {photos.map((p) => (
          <div key={p.storage_path} className="relative group">
            <div className="aspect-square rounded border border-border bg-background overflow-hidden flex items-center justify-center">
              {p.file_type?.startsWith("image/") && p.preview_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.preview_url}
                  alt={p.file_name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <FileIcon className="h-5 w-5 text-muted" />
              )}
            </div>
            <button
              type="button"
              onClick={() => onRemove(p)}
              className="absolute top-0.5 right-0.5 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 cursor-pointer"
              aria-label="Remove photo"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="aspect-square rounded border border-dashed border-border-strong flex items-center justify-center text-muted hover:border-brand-500 hover:text-brand-600 cursor-pointer disabled:opacity-50"
          aria-label="Add photos"
        >
          <Upload className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function ClientChoicePicker({
  choices,
  attachmentsForChoice,
  selected,
  onSelect,
  locked,
  approvedChoiceId,
  allowance,
  allowanceCostCode,
}: {
  choices: Choice[]
  attachmentsForChoice: (key: string) => Attachment[]
  selected: string | null
  onSelect: (id: string) => void
  locked: boolean
  approvedChoiceId: string | null
  allowance: number | null
  allowanceCostCode: Pick<
    DecisionsData["cost_codes"][number],
    "code" | "name"
  > | null
}) {
  if (choices.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background/40 p-3 text-sm text-muted">
        No options have been added yet.
      </div>
    )
  }
  const hasAllowance = allowance != null
  return (
    <div className="space-y-2">
      <Label>
        <Palette className="inline h-3 w-3 mr-1 text-blue-500" />
        {locked ? "Choices" : "Pick one"}
      </Label>
      {hasAllowance && (
        <div className="rounded-md border border-blue-200 bg-blue-50/40 p-2.5 text-xs text-blue-900">
          <span className="font-medium">
            Allowance {formatCurrency(allowance ?? 0)}
          </span>
          {allowanceCostCode && (
            <span className="text-blue-800/70">
              {" "}
              · {allowanceCostCode.name}
            </span>
          )}
          <span className="text-blue-800/80">
            {" "}
            — already included in your contract. You only pay or get credit
            for the difference.
          </span>
        </div>
      )}
      <ul className="space-y-2">
        {choices.map((c, i) => {
          const isSelected = selected === c.client_key
          const isApproved = approvedChoiceId && c.id === approvedChoiceId
          const photos = attachmentsForChoice(c.client_key)
          const variance =
            hasAllowance && c.price_delta != null
              ? Number(c.price_delta) - (allowance ?? 0)
              : null
          return (
            <li key={c.client_key}>
              <button
                type="button"
                disabled={locked}
                onClick={() => onSelect(c.client_key)}
                className={cn(
                  "w-full text-left rounded-md border p-3 transition-colors",
                  locked ? "cursor-default" : "cursor-pointer hover:bg-background/60",
                  isApproved
                    ? "border-green-500 ring-1 ring-green-500/20 bg-green-50/40"
                    : isSelected
                    ? "border-blue-500 ring-1 ring-blue-500/20"
                    : "border-border"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {isApproved ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : isSelected ? (
                      <CheckCircle2 className="h-5 w-5 text-blue-600" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">
                        {String.fromCharCode(65 + i)}. {c.title}
                      </span>
                      {isApproved && (
                        <Badge tone="success">Your choice</Badge>
                      )}
                      {hasAllowance && c.price_delta != null ? (
                        <>
                          <span className="text-xs font-mono tabular-nums text-muted">
                            Cost {formatCurrency(Number(c.price_delta))}
                          </span>
                          {variance != null && (
                            <Badge
                              tone={
                                variance > 0
                                  ? "danger"
                                  : variance < 0
                                  ? "success"
                                  : "muted"
                              }
                            >
                              {variance > 0
                                ? `+${formatCurrency(variance)} you pay`
                                : variance < 0
                                ? `${formatCurrency(Math.abs(variance))} credit`
                                : "no charge"}
                            </Badge>
                          )}
                        </>
                      ) : (
                        c.price_delta != null &&
                        c.price_delta !== 0 && (
                          <CostDelta value={Number(c.price_delta)} />
                        )
                      )}
                    </div>
                    {c.description && (
                      <p className="text-sm text-muted mt-1 whitespace-pre-wrap">
                        {c.description}
                      </p>
                    )}
                    {photos.length > 0 && (
                      <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                        {photos.map((p) => (
                          <div
                            key={p.storage_path}
                            className="aspect-square rounded border border-border bg-background overflow-hidden flex items-center justify-center"
                          >
                            {p.file_type?.startsWith("image/") && p.preview_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.preview_url}
                                alt={p.file_name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <FileIcon className="h-5 w-5 text-muted" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function FollowupsEditor({
  value,
  onChange,
  profiles,
  companies,
  workItems,
  alreadyApproved,
}: {
  value: Followup[]
  onChange: (v: Followup[]) => void
  profiles: DecisionsData["profiles"]
  companies: DecisionsData["companies"]
  workItems: DecisionsData["work_items"]
  alreadyApproved: boolean
}) {
  function add() {
    onChange([...value, { title: "", kind: "todo", due_offset_days: 7 }])
  }
  function update(i: number, patch: Partial<Followup>) {
    onChange(value.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>
          <Sparkles className="inline h-3 w-3 mr-1 text-brand-500" />
          Follow-up schedule items
        </Label>
        {alreadyApproved && (
          <span className="text-xs text-muted">
            (already approved — new ones are added to the schedule on the next
            save)
          </span>
        )}
      </div>
      <p className="text-xs text-muted mt-0.5">
        When this decision is approved, these are auto-created on the Schedule
        and assigned to the chosen person. A to-do gets a due date; a work item
        gets a start date + duration. Link the date to an existing schedule
        item to have it move automatically when that item shifts.
      </p>
      {value.length > 0 && (
        <ul className="mt-2 space-y-2">
          {value.map((f, i) => {
            const anchored = !!f.anchor_schedule_item_id
            const isWork = f.kind === "work"
            return (
              <li
                key={i}
                className="rounded-md border border-border p-2.5 bg-background/50 space-y-2"
              >
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_180px_auto] gap-2 items-center">
                  <Input
                    value={f.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                    placeholder={
                      isWork
                        ? "E.g. Frame the addition"
                        : "E.g. Update plans / Issue PO"
                    }
                  />
                  <Select
                    value={f.kind}
                    onChange={(e) =>
                      update(i, {
                        kind: e.target.value as "todo" | "work",
                        // Seed a sensible duration when switching to work.
                        duration_days:
                          e.target.value === "work"
                            ? f.duration_days ?? 1
                            : f.duration_days,
                      })
                    }
                    title="Schedule item type"
                  >
                    <option value="todo">To-do</option>
                    <option value="work">Work item</option>
                  </Select>
                  <Select
                    value={
                      f.assignee_profile_id
                        ? `p:${f.assignee_profile_id}`
                        : f.assignee_company_id
                        ? `c:${f.assignee_company_id}`
                        : ""
                    }
                    onChange={(e) => {
                      const v = e.target.value
                      if (v.startsWith("p:")) {
                        update(i, {
                          assignee_profile_id: v.slice(2),
                          assignee_company_id: null,
                        })
                      } else if (v.startsWith("c:")) {
                        update(i, {
                          assignee_profile_id: null,
                          assignee_company_id: v.slice(2),
                        })
                      } else {
                        update(i, {
                          assignee_profile_id: null,
                          assignee_company_id: null,
                        })
                      }
                    }}
                  >
                    <option value="">— Assign to —</option>
                    <optgroup label="Staff">
                      {profiles
                        .filter((p) => p.role === "staff")
                        .map((p) => (
                          <option key={p.id} value={`p:${p.id}`}>
                            {p.full_name || p.email}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="Subs / vendors">
                      {companies
                        .filter((c) => c.type !== "client")
                        .map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
                  </Select>
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                    className="text-muted hover:text-danger p-1 cursor-pointer justify-self-end"
                    aria-label="Remove follow-up"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Scheduling: fixed offset from approval, or anchored to a
                    schedule item (start/end ± offset). */}
                <div className="flex flex-wrap items-end gap-2 pl-0.5">
                  <Select
                    value={anchored ? "anchored" : "fixed"}
                    onChange={(e) => {
                      if (e.target.value === "anchored") {
                        update(i, {
                          anchor_schedule_item_id: workItems[0]?.id ?? "",
                          parent_anchor: "end",
                          parent_offset_days: f.parent_offset_days ?? 0,
                        })
                      } else {
                        update(i, {
                          anchor_schedule_item_id: null,
                          parent_anchor: null,
                          parent_offset_days: null,
                        })
                      }
                    }}
                    className="w-auto text-xs"
                    disabled={workItems.length === 0 && !anchored}
                    title={
                      workItems.length === 0
                        ? "No work items in this project to anchor to"
                        : undefined
                    }
                  >
                    <option value="fixed">
                      {isWork ? "Start: days after approval" : "Due: days after approval"}
                    </option>
                    <option value="anchored">Link to a schedule item</option>
                  </Select>

                  {anchored ? (
                    <>
                      <Field label="Schedule item" className="min-w-[150px]">
                        <Select
                          value={f.anchor_schedule_item_id ?? ""}
                          onChange={(e) =>
                            update(i, {
                              anchor_schedule_item_id: e.target.value || null,
                            })
                          }
                        >
                          {workItems.length === 0 && (
                            <option value="">— none —</option>
                          )}
                          {workItems.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.title}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Anchor">
                        <Select
                          value={f.parent_anchor ?? "end"}
                          onChange={(e) =>
                            update(i, {
                              parent_anchor: e.target.value as "start" | "end",
                            })
                          }
                          className="w-auto"
                        >
                          <option value="start">Start</option>
                          <option value="end">End</option>
                        </Select>
                      </Field>
                      <Field
                        label="Offset (days)"
                        hint="− before / + after"
                      >
                        <Input
                          type="number"
                          step={1}
                          value={f.parent_offset_days ?? 0}
                          onChange={(e) =>
                            update(i, {
                              parent_offset_days: Math.trunc(
                                Number(e.target.value) || 0
                              ),
                            })
                          }
                          className="w-24 text-right tabular-nums"
                        />
                      </Field>
                      <FollowupAnchorPreview
                        item={
                          workItems.find(
                            (w) => w.id === f.anchor_schedule_item_id
                          ) ?? null
                        }
                        anchor={f.parent_anchor ?? "end"}
                        offsetDays={f.parent_offset_days ?? 0}
                        label={isWork ? "Starts" : "Due"}
                      />
                    </>
                  ) : (
                    <Field label="Days after approval">
                      <Input
                        type="number"
                        min={0}
                        value={f.due_offset_days}
                        onChange={(e) =>
                          update(i, {
                            due_offset_days: Math.max(
                              0,
                              Number(e.target.value) || 0
                            ),
                          })
                        }
                        className="w-24 text-right tabular-nums"
                      />
                    </Field>
                  )}

                  {isWork && (
                    <Field label="Duration (days)">
                      <Input
                        type="number"
                        min={1}
                        value={f.duration_days ?? 1}
                        onChange={(e) =>
                          update(i, {
                            duration_days: Math.max(
                              1,
                              Number(e.target.value) || 1
                            ),
                          })
                        }
                        className="w-24 text-right tabular-nums"
                      />
                    </Field>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={add}
        className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add follow-up
      </button>
    </div>
  )
}

function CommentsThread({
  decisionId,
  projectId,
  comments,
  profiles,
  meName,
  canPost,
  isClient,
}: {
  decisionId?: string
  projectId: string
  comments: Tables<"decision_comments">[]
  profiles: DecisionsData["profiles"]
  meName: string
  canPost: boolean
  isClient: boolean
}) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!decisionId || !body.trim()) return
    startTransition(async () => {
      try {
        await postComment({
          decision_id: decisionId,
          project_id: projectId,
          body,
        })
        setBody("")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not post")
      }
    })
  }

  return (
    <div>
      <Label>
        <MessageSquare className="inline h-3 w-3 mr-1" />
        Comments
      </Label>
      <ul className="mt-2 space-y-2">
        {comments.length === 0 && (
          <li className="text-xs text-muted">No comments yet.</li>
        )}
        {comments.map((c) => {
          const author = profiles.find((p) => p.id === c.author_id)
          const name = author?.full_name || author?.email || "Someone"
          const isClientAuthor = author?.role === "client"
          return (
            <li
              key={c.id}
              className="flex items-start gap-2 rounded-md border border-border p-2 bg-background/30"
            >
              <Avatar name={name} size="sm" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{name}</span>
                  {isClientAuthor && (
                    <span className="text-[10px] text-blue-700 bg-blue-100 px-1 py-0.5 rounded">
                      client
                    </span>
                  )}
                  <span className="text-xs text-muted">
                    {formatDate(c.created_at)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap mt-0.5">{c.body}</p>
              </div>
            </li>
          )
        })}
      </ul>
      {canPost && (
        <div className="mt-3 flex gap-2 items-end">
          <Avatar name={meName} size="sm" />
          <div className="flex-1">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={isClient ? "Reply…" : "Reply to client / leave a note"}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={pending || !body.trim()}
          >
            Post
          </Button>
        </div>
      )}
      {!decisionId && (
        <p className="mt-2 text-xs text-muted">
          Comments are available after saving the decision.
        </p>
      )}
    </div>
  )
}

function CostBreakdownEditor({
  items,
  onChange,
  costCodes,
  markupPercent,
  onMarkupChange,
  subtotal,
  total,
}: {
  items: CostItem[]
  onChange: (v: CostItem[]) => void
  costCodes: DecisionsData["cost_codes"]
  markupPercent: string
  onMarkupChange: (v: string) => void
  subtotal: number
  total: number
}) {
  function add() {
    onChange([
      ...items,
      {
        cost_code_id: null,
        description: "",
        quantity: 1,
        unit: null,
        unit_cost: 0,
      },
    ])
  }

  function update(i: number, patch: Partial<CostItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }

  return (
    <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          <Calculator className="inline h-3 w-3 mr-1 text-brand-500" />
          Cost breakdown
        </Label>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted">
          <EyeOff className="h-3 w-3" />
          Internal — clients see only the marked-up total
        </span>
      </div>
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left font-medium pb-1.5 w-[28%]">Cost code</th>
                <th className="text-left font-medium pb-1.5">Description</th>
                <th className="text-right font-medium pb-1.5 w-20">Qty</th>
                <th className="text-left font-medium pb-1.5 w-16">Unit</th>
                <th className="text-right font-medium pb-1.5 w-28">Unit cost</th>
                <th className="text-right font-medium pb-1.5 w-28">Line total</th>
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((ci, i) => {
                const lineTotal = (ci.quantity || 0) * (ci.unit_cost || 0)
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-1.5 pb-1.5">
                      <Select
                        value={ci.cost_code_id ?? ""}
                        onChange={(e) =>
                          update(i, { cost_code_id: e.target.value || null })
                        }
                      >
                        <option value="">— Select —</option>
                        {costCodes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        value={ci.description ?? ""}
                        onChange={(e) =>
                          update(i, { description: e.target.value })
                        }
                        placeholder="Detail"
                      />
                    </td>
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={ci.quantity}
                        onChange={(e) =>
                          update(i, { quantity: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        value={ci.unit ?? ""}
                        onChange={(e) => update(i, { unit: e.target.value })}
                        placeholder="ea"
                      />
                    </td>
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={ci.unit_cost}
                        onChange={(e) =>
                          update(i, { unit_cost: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="pr-1.5 pb-1.5 text-right font-mono tabular-nums pt-2">
                      {formatCurrency(lineTotal)}
                    </td>
                    <td className="pb-1.5 pt-2">
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="text-muted hover:text-danger p-1 cursor-pointer"
                        aria-label="Remove line"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add line
      </button>
      {items.length > 0 && (
        <div className="border-t border-border pt-2 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted">Subtotal (cost)</span>
            <span className="font-mono tabular-nums">
              {formatCurrency(subtotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-muted flex items-center gap-2">
              Markup %
              <Input
                type="number"
                step="0.01"
                value={markupPercent}
                onChange={(e) => onMarkupChange(e.target.value)}
                placeholder="0"
                className="w-24 text-right tabular-nums"
              />
            </label>
            <span className="font-mono tabular-nums text-muted">
              + {formatCurrency(total - subtotal)}
            </span>
          </div>
          <div className="flex items-center justify-between font-semibold border-t border-border pt-1.5">
            <span>Breakdown total (before delay)</span>
            <span className="font-mono tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function AttachmentTile({
  att,
  canEdit,
  onRemove,
  onCaption,
}: {
  att: Attachment
  canEdit: boolean
  onRemove: () => void
  onCaption: (c: string) => void
}) {
  const isImage = att.file_type?.startsWith("image/") ?? false
  return (
    <div className="relative group">
      <div className="aspect-square rounded-md overflow-hidden border border-border bg-background flex items-center justify-center">
        {isImage && att.preview_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={att.preview_url}
            alt={att.file_name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center text-muted text-[10px] p-1">
            <FileIcon className="h-6 w-6 mb-1" />
            <span className="truncate w-full text-center" title={att.file_name}>
              {att.file_name}
            </span>
          </div>
        )}
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 cursor-pointer"
          aria-label="Remove"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <Input
        value={att.caption ?? ""}
        onChange={(e) => onCaption(e.target.value)}
        placeholder="Caption"
        disabled={!canEdit}
        className="mt-1 text-[11px] h-7 px-2"
      />
    </div>
  )
}

// Live preview of the date a schedule-anchored follow-up will land on. Mirrors
// the AnchoredDuePreview in the schedule dialog.
function FollowupAnchorPreview({
  item,
  anchor,
  offsetDays,
  label,
}: {
  item: DecisionsData["work_items"][number] | null
  anchor: "start" | "end"
  offsetDays: number
  label: string
}) {
  let text: string
  if (!item) {
    text = "Pick a schedule item"
  } else {
    const basis = anchor === "start" ? item.start_date : item.end_date
    text = basis
      ? `${label} ${formatDate(addDays(basis, offsetDays))}`
      : `${label} once parent has a ${anchor} date`
  }
  return (
    <div className="flex items-center gap-1 text-xs text-muted h-9 px-1">
      <CalendarClock className="h-3.5 w-3.5 text-brand-500 shrink-0" />
      <span className="font-mono tabular-nums">{text}</span>
    </div>
  )
}

// Inline footer shown in place of the normal action row while the staff is
// choosing a copy destination. Rendered inline (not as a nested Dialog) to
// avoid two focus-traps fighting over Tab.
function CopyDecisionFooter({
  projects,
  currentProjectId,
  pending,
  onCancel,
  onCopy,
}: {
  projects: DecisionsData["projects"]
  currentProjectId: string
  pending: boolean
  onCancel: () => void
  onCopy: (targetProjectId: string) => void
}) {
  const [target, setTarget] = useState(currentProjectId)
  const sorted = [...projects].sort((a, b) =>
    a.project_number.localeCompare(b.project_number)
  )
  return (
    <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <Label className="mb-1">Copy this item to…</Label>
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          {sorted.map((p) => (
            <option key={p.id} value={p.id}>
              {p.project_number} — {p.name}
              {p.id === currentProjectId ? " (this project)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-2 sm:self-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={() => onCopy(target)} disabled={pending}>
          <Copy className="h-4 w-4" />
          {pending ? "Copying…" : "Create copy"}
        </Button>
      </div>
    </DialogFooter>
  )
}
