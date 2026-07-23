"use client"

import { useState, useTransition, useRef, useEffect, useMemo, Fragment } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { toastActionError, actionErrorMessage } from "@/lib/action-error"
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
  Eye,
  BookMarked,
  Users,
  FileText,
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
  requestDueDateReset,
  type DecisionInputT,
} from "@/app/actions/decisions"
import {
  searchCatalogItems,
  type CatalogItemHit,
} from "@/app/actions/catalog"
import { createPoFromDecision } from "@/app/actions/purchase-orders"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { formatTags, parseTagsInput, collectBaseTags } from "@/lib/template-tags"
import { TemplateTagsInput } from "@/components/template-tags-input"
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
  // Optional link to the HH-SpecMagician catalog (bare uuid + display-snapshot
  // code). Editing the line's description/cost manually does NOT unlink it.
  catalog_item_id: string | null
  catalog_item_code: string | null
}

// A decision assignment targets exactly one of person / company / role
// (mirrors decision_assignments' DB CHECK).
type AssignmentDraft = {
  profile_id: string | null
  company_id: string | null
  role_id: string | null
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
  // Existing template-tag vocabulary across this project's decisions, so the
  // tags field can suggest reusing one instead of coining a variant.
  const tagSuggestions = useMemo(
    () => collectBaseTags(data.decisions.map((d) => d.template_tags)),
    [data.decisions]
  )
  const [dueDate, setDueDate] = useState<string>(decision?.due_date ?? "")
  // Due-date link: instead of a fixed date, the due date can follow a
  // schedule item (start/end ± offset). Server recomputes due_date from the
  // item on save, and a DB trigger keeps it fresh as the item moves.
  const [dueAnchorItemId, setDueAnchorItemId] = useState<string | null>(
    decision?.due_anchor_schedule_item_id ?? null
  )
  const [dueAnchor, setDueAnchor] = useState<"start" | "end">(
    decision?.due_anchor ?? "end"
  )
  const [dueAnchorOffset, setDueAnchorOffset] = useState<number>(
    decision?.due_anchor_offset_days ?? 0
  )
  const dueLinked = !!dueAnchorItemId
  const dueAnchorItem =
    data.work_items.find((w) => w.id === dueAnchorItemId) ?? null
  // Client-side preview of the linked recipe; the server's computation on
  // save is authoritative.
  const linkedDueBasis = dueAnchorItem
    ? dueAnchor === "start"
      ? dueAnchorItem.start_date
      : dueAnchorItem.end_date
    : null
  const effectiveDueDate = dueLinked
    ? linkedDueBasis
      ? addDays(linkedDueBasis, dueAnchorOffset)
      : null
    : dueDate || null
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
        catalog_item_id: ci.catalog_item_id,
        catalog_item_code: ci.catalog_item_code,
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
  // Who this decision is assigned to (0075). Sent on every save — the server
  // replaces the full set, so an empty array clears assignments.
  const [assignments, setAssignments] = useState<AssignmentDraft[]>(() => {
    if (!decision) return []
    return data.assignments
      .filter((a) => a.decision_id === decision.id)
      .map((a) => ({
        profile_id: a.profile_id,
        company_id: a.company_id,
        role_id: a.role_id,
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
            catalog_item_id: ci.catalog_item_id,
            catalog_item_code: ci.catalog_item_code,
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
  // Staff-only: which choice they're approving on the client's behalf. Drives
  // both the "Chosen" badge and the cost that flows to billing. Defaults to
  // the client's/prior pick (a saved choice's client_key equals its id). A
  // lone-choice selection is auto-selected server-side, so a click is only
  // required when there's more than one option.
  const [staffSelectedChoiceKey, setStaffSelectedChoiceKey] = useState<
    string | null
  >(decision?.selected_choice_id ?? null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  // Inline vendor picker for "Create PO…" on an approved decision.
  const [createPoOpen, setCreatePoOpen] = useState(false)

  // The PO copies the SAVED decision (title/description/cost breakdown), so
  // visible-but-unsaved edits would silently be missing from it. Fingerprint
  // the PO-feeding fields against their last-saved values before creating.
  function poSourceDirty(): boolean {
    if (!decision) return false
    if (title !== (decision.title ?? "")) return true
    if (description !== (decision.description ?? "")) return true
    const itemKey = (
      choiceId: string | null,
      costCodeId: string | null | undefined,
      desc: string | null | undefined,
      quantity: number,
      unitCost: number
    ) =>
      JSON.stringify([choiceId, costCodeId ?? null, desc ?? null, quantity, unitCost])
    const saved = data.cost_items
      .filter((ci) => ci.decision_id === decision.id)
      .map((ci) =>
        itemKey(
          ci.choice_id,
          ci.cost_code_id,
          ci.description,
          Number(ci.quantity),
          Number(ci.unit_cost)
        )
      )
      .sort()
    const current = [
      ...costItems.map((ci) =>
        itemKey(
          null,
          ci.cost_code_id,
          ci.description,
          Number(ci.quantity),
          Number(ci.unit_cost)
        )
      ),
      ...choices.flatMap((c) =>
        c.cost_items.map((ci) =>
          itemKey(
            // Saved choices carry their DB id; a brand-new unsaved choice has
            // none, which correctly reads as a difference.
            c.id ?? "unsaved",
            ci.cost_code_id,
            ci.description,
            Number(ci.quantity),
            Number(ci.unit_cost)
          )
        )
      ),
    ].sort()
    return JSON.stringify(saved) !== JSON.stringify(current)
  }

  function handleCreatePo(companyId: string) {
    if (!decision) return
    if (poSourceDirty()) {
      toast.error(
        "Save your changes first — the PO copies the saved cost breakdown."
      )
      setCreatePoOpen(false)
      return
    }
    startTransition(async () => {
      try {
        const { id, project_id, already_linked } = await createPoFromDecision({
          decision_id: decision.id,
          company_id: companyId,
        })
        toast.success(
          already_linked
            ? `Draft PO created (note: ${already_linked} earlier PO${
                already_linked === 1 ? "" : "s"
              } already came from this item)`
            : "Draft PO created"
        )
        router.push(`/projects/${project_id}/purchasing?tab=pos&open=${id}`)
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not create the PO")
      }
    })
  }

  // Staff can flip into a read-only "client preview" to sanity-check what the
  // owner will see. Every isClient/canEdit branch below flows from these
  // derived values, so the whole drawer follows the toggle. actualClient stays
  // separate: preview must render the client layout without granting the
  // client's WRITE affordances (comment posting).
  const actualClient = data.role === "client"
  const [previewAsClient, setPreviewAsClient] = useState(false)
  const isClient = actualClient || previewAsClient
  const canEdit = data.role === "staff" && !previewAsClient

  // Past-due approval gate: the client_decide_decision RPC rejects approvals
  // once due_date < today (0074), so pre-empt it in the UI. Same date
  // convention as DueCell in decisions-client.tsx.
  const overdue =
    !!decision?.due_date &&
    decision.due_date < new Date().toISOString().slice(0, 10)
  const [resetPending, startResetTransition] = useTransition()
  const [resetRequested, setResetRequested] = useState(false)

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
    // Approving a selection bills the chosen option's cost. A lone choice is
    // auto-selected server-side, but with two or more options staff must say
    // which one is being approved (the client's own pick pre-fills this).
    if (kind === "selection" && (overrideStatus ?? status) === "approved") {
      const namedChoices = choices.filter((c) => c.title.trim() !== "")
      if (namedChoices.length > 1 && !staffSelectedChoiceKey) {
        toast.error("Tap “Choose” on the option being approved so its cost bills correctly.")
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
            catalog_item_id: ci.catalog_item_id,
            catalog_item_code: ci.catalog_item_code,
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
      // When linked, the server derives due_date from the schedule item —
      // send the recipe, not a date.
      due_date: dueLinked ? null : dueDate || null,
      due_anchor_schedule_item_id: dueLinked ? dueAnchorItemId : null,
      due_anchor: dueLinked ? dueAnchor : null,
      due_anchor_offset_days: dueLinked ? dueAnchorOffset : null,
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
                    catalog_item_id: ci.catalog_item_id,
                    catalog_item_code: ci.catalog_item_code,
                  })),
              }))
          : [],
      // Which choice staff is approving (client_key). Server auto-selects a
      // lone choice and otherwise falls back to the client's own pick, so this
      // only needs to carry a value for multi-choice staff approvals.
      selected_choice_key: kind === "selection" ? staffSelectedChoiceKey : null,
      // Selections only, matching choices above: a create-mode kind switch
      // must not persist assignments (invisible on change orders, and they'd
      // grant trades read access) — the server mirrors this gate.
      assignments: kind === "selection" ? assignments : [],
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
        toastActionError(e, "Save failed")
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
        toastActionError(e, "Delete failed")
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
        toastActionError(e, "Reset failed")
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
        toastActionError(e, "Copy failed")
      }
    })
  }

  function handleClientDecide(action: "approve" | "decline") {
    if (!decision) return
    // Staff preview renders these buttons disabled; belt-and-braces here.
    if (previewAsClient) return
    if (action === "approve" && overdue) {
      toast.error(
        "The approval window for this item has passed — request a due-date reset first."
      )
      return
    }
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
        toastActionError(e, "Could not submit")
      }
    })
  }

  function handleRequestDueReset() {
    if (!decision || previewAsClient) return
    startResetTransition(async () => {
      const r = await requestDueDateReset({
        decision_id: decision.id,
        project_id: data.project_id,
      })
      if (r.ok) {
        setResetRequested(true)
        toast.success("Request sent — we'll extend the due date.")
        // The action leaves a comment on the decision — pull it in.
        router.refresh()
      } else {
        toast.error(r.error)
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
              {effectiveDueDate && (
                <span className="text-xs text-muted">
                  Due {formatDate(effectiveDueDate)}
                  {dueLinked && (
                    <CalendarClock className="inline h-3 w-3 ml-1 text-brand-500 align-[-2px]" />
                  )}
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
          {/* mr-8 keeps clear of the dialog's absolute close button. */}
          {data.role === "staff" && mode === "edit" && decision && (
            <Button
              type="button"
              size="sm"
              variant={previewAsClient ? "secondary" : "ghost"}
              onClick={() => setPreviewAsClient((v) => !v)}
              className="mr-8 shrink-0"
              title={
                previewAsClient
                  ? "Back to the staff editor"
                  : "See this item exactly as the client will"
              }
            >
              <Eye className="h-3.5 w-3.5" />
              {previewAsClient ? "Exit preview" : "Preview as client"}
            </Button>
          )}
        </DialogHeader>
        <DialogBody className="space-y-6">
          {previewAsClient && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center justify-between gap-3">
              <span>Client preview — this is what the client sees.</span>
              <button
                type="button"
                onClick={() => setPreviewAsClient(false)}
                className="font-medium underline underline-offset-2 hover:text-amber-950 cursor-pointer shrink-0"
              >
                Exit preview
              </button>
            </div>
          )}
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
          {canEdit ? (
            <div>
              <Label>Due date</Label>
              <p className="text-xs text-muted mt-0.5">
                Optional. Shown to the owner so they know when to respond.
                Link it to a schedule item to have it move automatically when
                the schedule shifts.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Select
                  value={dueLinked ? "linked" : "fixed"}
                  onChange={(e) => {
                    if (e.target.value === "linked") {
                      setDueAnchorItemId(data.work_items[0]?.id ?? null)
                      setDueAnchor("end")
                      // Reset the offset too — otherwise a value left over
                      // from a prior link/edit silently rides into the new
                      // recipe alongside the freshly reset item + anchor.
                      setDueAnchorOffset(0)
                    } else {
                      setDueAnchorItemId(null)
                    }
                  }}
                  className="w-auto text-xs"
                  disabled={data.work_items.length === 0 && !dueLinked}
                  title={
                    data.work_items.length === 0
                      ? "No work items in this project to link to"
                      : undefined
                  }
                >
                  <option value="fixed">Fixed date</option>
                  <option value="linked">Link to a schedule item</option>
                </Select>
                {dueLinked ? (
                  <>
                    <Field label="Schedule item" className="min-w-[150px]">
                      <Select
                        value={dueAnchorItemId ?? ""}
                        onChange={(e) =>
                          setDueAnchorItemId(e.target.value || null)
                        }
                      >
                        {data.work_items.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.title}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Anchor">
                      <Select
                        value={dueAnchor}
                        onChange={(e) =>
                          setDueAnchor(e.target.value as "start" | "end")
                        }
                        className="w-auto"
                      >
                        <option value="start">Start</option>
                        <option value="end">End</option>
                      </Select>
                    </Field>
                    <Field label="Offset (days)" hint="− before / + after">
                      <Input
                        type="number"
                        step={1}
                        value={dueAnchorOffset}
                        onChange={(e) =>
                          setDueAnchorOffset(
                            Math.trunc(Number(e.target.value) || 0)
                          )
                        }
                        className="w-24 text-right tabular-nums"
                      />
                    </Field>
                    <FollowupAnchorPreview
                      item={dueAnchorItem}
                      anchor={dueAnchor}
                      offsetDays={dueAnchorOffset}
                      label="Due"
                    />
                  </>
                ) : (
                  <Field label="Date">
                    <Input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                    />
                  </Field>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Due date"
                hint={
                  decision?.due_anchor_schedule_item_id
                    ? "Builder is asking for a response by this date. It follows the construction schedule and may move if the schedule shifts."
                    : "Builder is asking for a response by this date."
                }
              >
                <Input type="date" value={dueDate} disabled />
              </Field>
            </div>
          )}
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
              <TemplateTagsInput
                value={templateTagsText}
                onChange={setTemplateTagsText}
                suggestions={tagSuggestions}
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
                  // Don't leave the "Chosen" pick pointing at a removed option.
                  setStaffSelectedChoiceKey((cur) => (cur === key ? null : cur))
                }}
                uploading={uploading}
                selectedChoiceKey={staffSelectedChoiceKey}
                onSelectChoice={setStaffSelectedChoiceKey}
                pinChosen={status === "approved"}
                allowance={allowanceNum}
                markupPercent={markupNum}
                markupPercentText={markupPercent}
                onMarkupPercentChange={setMarkupPercent}
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

          {/* Assigned to (selections only) — feeds the trade portal. */}
          {canEdit && kind === "selection" && (
            <AssignmentsEditor
              value={assignments}
              onChange={setAssignments}
              profiles={data.profiles}
              companies={data.companies}
              roles={data.roles}
              roleMembers={data.roleMembers}
            />
          )}

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
            canPost={!!decision && (canEdit || actualClient)}
            isClient={isClient}
          />

          {/* Org-wide disclaimer — clients only, both kinds. */}
          {isClient && !!data.disclaimer?.trim() && (
            <div className="border-t border-border pt-3 text-xs text-muted whitespace-pre-wrap">
              {data.disclaimer}
            </div>
          )}
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
        {canEdit && !copyOpen && createPoOpen && decision && (
          <CreatePoFooter
            companies={data.companies}
            assignments={assignments}
            pending={pending}
            onCancel={() => setCreatePoOpen(false)}
            onCreate={handleCreatePo}
          />
        )}
        {canEdit && !copyOpen && !createPoOpen && (
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
              <>
                {decision && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setCreatePoOpen(true)}
                    disabled={pending}
                    title="Create a draft purchase order from the approved cost breakdown"
                  >
                    <FileText className="h-4 w-4" /> Create PO…
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleReset}
                  disabled={pending}
                >
                  <RotateCcw className="h-4 w-4" /> Reset to draft
                </Button>
              </>
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
          <DialogFooter className="flex-wrap">
            {overdue && (
              <div className="mr-auto flex flex-col items-start gap-1.5 min-w-0">
                <span className="text-xs text-danger">
                  The approval window for this item has passed — ask us to
                  reset the due date, then approve.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleRequestDueReset}
                  disabled={resetPending || resetRequested || previewAsClient}
                  title={previewAsClient ? "Disabled in preview" : undefined}
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  {resetRequested
                    ? "Request sent"
                    : resetPending
                    ? "Sending…"
                    : "Request due-date reset"}
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleClientDecide("decline")}
              disabled={pending || previewAsClient}
              title={previewAsClient ? "Disabled in preview" : undefined}
              className="text-danger"
            >
              <XCircle className="h-4 w-4" /> Decline
            </Button>
            <Button
              type="button"
              onClick={() => handleClientDecide("approve")}
              disabled={
                pending ||
                previewAsClient ||
                overdue ||
                (kind === "selection" && !clientSelectedChoiceKey)
              }
              title={
                previewAsClient
                  ? "Disabled in preview"
                  : overdue
                  ? "The due date has passed — request a reset first"
                  : undefined
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

/**
 * Letters each choice by its SAVED position ("C." keeps reading "C." after a
 * move, so options still match prior conversations about them) and, when
 * `pinKey` matches a choice's key, floats that choice to the top. Shared by
 * the staff editor (keyed by client_key) and the client picker (keyed by id)
 * so the two views' ordering can't drift.
 */
function pinChoiceFirst(
  choices: Choice[],
  keyOf: (c: Choice) => string | undefined,
  pinKey: string | null
): { c: Choice; letter: string }[] {
  const lettered = choices.map((c, i) => ({
    c,
    letter: String.fromCharCode(65 + i),
  }))
  if (!pinKey) return lettered
  return [...lettered].sort(
    (a, b) => Number(keyOf(b.c) === pinKey) - Number(keyOf(a.c) === pinKey)
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
  selectedChoiceKey,
  onSelectChoice,
  pinChosen,
  allowance,
  markupPercent,
  markupPercentText,
  onMarkupPercentChange,
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
  // client_key of the choice staff is approving (matches the client's pick
  // when re-opening an approved selection). Null = nothing chosen yet.
  selectedChoiceKey: string | null
  onSelectChoice: (key: string) => void
  // True once the decision is approved: the chosen card is surfaced at the
  // top of the list (display only — the saved order and letters keep their
  // positions, and live "Choose" clicks while drafting don't reorder).
  pinChosen: boolean
  // When non-null we're in the allowance flow: per-choice prices become
  // absolute costs and we surface a variance preview against this amount.
  allowance: number | null
  markupPercent: number
  // Raw text of the SHARED decision-level markup state — every choice's
  // breakdown footer edits the same value.
  markupPercentText: string
  onMarkupPercentChange: (v: string) => void
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
  // Same treatment as the client picker: once approved, the chosen option
  // floats to the top but keeps its original letter.
  const displayed = pinChoiceFirst(
    value,
    (c) => c.client_key,
    pinChosen ? selectedChoiceKey : null
  )

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
        {displayed.map(({ c, letter }) => {
          const photos = attachmentsForChoice(c.client_key)
          const isSelected = c.client_key === selectedChoiceKey
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
                  ? "border-success ring-2 ring-success/30 bg-success/10"
                  : "border-border"
              )}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs font-mono text-muted mt-2.5 w-5 text-right">
                  {letter}.
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
                <button
                  type="button"
                  onClick={() => onSelectChoice(c.client_key)}
                  className={cn(
                    "mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap cursor-pointer transition-colors",
                    isSelected
                      ? "border-green-500 bg-green-50 text-green-700"
                      : "border-border text-muted hover:border-green-500 hover:text-green-700"
                  )}
                  title="Mark this as the chosen option — its cost bills to the client on approval"
                >
                  {isSelected ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <Circle className="h-3 w-3" />
                  )}
                  {isSelected ? "Chosen" : "Choose"}
                </button>
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
                markupPercentText={markupPercentText}
                onMarkupPercentChange={onMarkupPercentChange}
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
  markupPercentText,
  onMarkupPercentChange,
}: {
  items: CostItem[]
  onChange: (v: CostItem[]) => void
  costCodes: DecisionsData["cost_codes"]
  // Shared decision-level markup — editing it here changes EVERY choice.
  markupPercentText: string
  onMarkupPercentChange: (v: string) => void
}) {
  const subtotal = items.reduce(
    (s, ci) => s + (Number(ci.quantity) || 0) * (Number(ci.unit_cost) || 0),
    0
  )
  // Same rounding as ChoicesEditor's effectivePrice so the footer total
  // matches the price shown on the choice row.
  const markupNum =
    markupPercentText === "" ? 0 : Number(markupPercentText) || 0
  const total = Math.round(subtotal * (1 + markupNum / 100) * 100) / 100
  // Which line's catalog search panel is open (one at a time per editor).
  const [catalogOpenIdx, setCatalogOpenIdx] = useState<number | null>(null)
  function add() {
    onChange([
      ...items,
      {
        cost_code_id: null,
        description: "",
        quantity: 1,
        unit: null,
        unit_cost: 0,
        catalog_item_id: null,
        catalog_item_code: null,
      },
    ])
  }
  function update(i: number, patch: Partial<CostItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  function remove(i: number) {
    setCatalogOpenIdx(null)
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
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((ci, i) => {
                const lineTotal = (ci.quantity || 0) * (ci.unit_cost || 0)
                return (
                  <Fragment key={i}>
                  <tr className="align-top">
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
                      {ci.catalog_item_id && (
                        <CatalogCodeChip
                          code={ci.catalog_item_code}
                          onClear={() =>
                            update(i, {
                              catalog_item_id: null,
                              catalog_item_code: null,
                            })
                          }
                        />
                      )}
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
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() =>
                            setCatalogOpenIdx(catalogOpenIdx === i ? null : i)
                          }
                          className={cn(
                            "p-1 cursor-pointer",
                            ci.catalog_item_id
                              ? "text-brand-600"
                              : "text-muted hover:text-brand-600"
                          )}
                          title="Link to SpecMagician catalog"
                          aria-label="Link to SpecMagician catalog"
                        >
                          <BookMarked className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="text-muted hover:text-danger p-1 cursor-pointer"
                          aria-label="Remove line"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {catalogOpenIdx === i && (
                    <tr>
                      <td colSpan={7} className="pb-1.5">
                        <CatalogLinkSearch
                          onPick={(item) => {
                            update(i, catalogPatch(item))
                            setCatalogOpenIdx(null)
                          }}
                          onClose={() => setCatalogOpenIdx(null)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="text-[11px] text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add line
      </button>
      {items.length > 0 && (
        <div className="border-t border-border pt-1.5 space-y-1 text-xs">
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
                value={markupPercentText}
                onChange={(e) => onMarkupPercentChange(e.target.value)}
                placeholder="0"
                className="w-20 h-7 text-right tabular-nums"
              />
              <span className="text-[10px] text-muted">
                Applies to every choice
              </span>
            </label>
            <span className="font-mono tabular-nums text-muted">
              + {formatCurrency(total - subtotal)}
            </span>
          </div>
          <div className="flex items-center justify-between font-semibold border-t border-border pt-1">
            <span>Choice price</span>
            <span className="font-mono tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
      )}
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
  const [viewPhoto, setViewPhoto] = useState<Attachment | null>(null)
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
                <button
                  type="button"
                  onClick={() => setViewPhoto(p)}
                  className="h-full w-full cursor-zoom-in"
                  aria-label={`View ${p.file_name} larger`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.preview_url}
                    alt={p.file_name}
                    className="h-full w-full object-cover"
                  />
                </button>
              ) : (
                <FileIcon className="h-5 w-5 text-muted" />
              )}
            </div>
            <button
              type="button"
              onClick={() => onRemove(p)}
              className="absolute top-0.5 right-0.5 rounded-full bg-black/60 text-white p-1.5 sm:p-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 cursor-pointer"
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
      {viewPhoto?.preview_url && (
        <Lightbox
          url={viewPhoto.preview_url}
          name={viewPhoto.file_name}
          onClose={() => setViewPhoto(null)}
        />
      )}
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
  const [viewPhoto, setViewPhoto] = useState<Attachment | null>(null)
  if (choices.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background/40 p-3 text-sm text-muted">
        No options have been added yet.
      </div>
    )
  }
  const hasAllowance = allowance != null
  // The approved pick floats to the top so it's unmissable.
  const ordered = pinChoiceFirst(choices, (c) => c.id, approvedChoiceId)
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
        {ordered.map(({ c, letter }) => {
          const isSelected = selected === c.client_key
          const isApproved = approvedChoiceId && c.id === approvedChoiceId
          const photos = attachmentsForChoice(c.client_key)
          const variance =
            hasAllowance && c.price_delta != null
              ? Number(c.price_delta) - (allowance ?? 0)
              : null
          return (
            <li key={c.client_key}>
              {/* div[role=button] rather than <button>: the photo tiles
                  inside are themselves buttons (click to enlarge), and
                  nested buttons are invalid HTML. */}
              <div
                role={locked ? undefined : "button"}
                tabIndex={locked ? undefined : 0}
                onClick={locked ? undefined : () => onSelect(c.client_key)}
                onKeyDown={
                  locked
                    ? undefined
                    : (e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          onSelect(c.client_key)
                        }
                      }
                }
                className={cn(
                  "w-full text-left rounded-md border p-3 transition-colors",
                  locked ? "cursor-default" : "cursor-pointer hover:bg-background/60",
                  isApproved
                    ? "border-success ring-2 ring-success/40 bg-success/10"
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
                        {letter}. {c.title}
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
                        {photos.map((p) =>
                          p.file_type?.startsWith("image/") &&
                          p.preview_url ? (
                            <button
                              key={p.storage_path}
                              type="button"
                              onClick={(e) => {
                                // Don't also select the choice card.
                                e.stopPropagation()
                                setViewPhoto(p)
                              }}
                              className="aspect-square rounded border border-border bg-background overflow-hidden cursor-zoom-in"
                              aria-label={`View ${p.file_name} larger`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={p.preview_url}
                                alt={p.file_name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div
                              key={p.storage_path}
                              className="aspect-square rounded border border-border bg-background overflow-hidden flex items-center justify-center"
                            >
                              <FileIcon className="h-5 w-5 text-muted" />
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {viewPhoto?.preview_url && (
        <Lightbox
          url={viewPhoto.preview_url}
          name={viewPhoto.file_name}
          onClose={() => setViewPhoto(null)}
        />
      )}
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
                    <optgroup label="Team">
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
        toastActionError(e, "Could not post")
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
  // Which line's catalog search panel is open (one at a time per editor).
  const [catalogOpenIdx, setCatalogOpenIdx] = useState<number | null>(null)

  function add() {
    onChange([
      ...items,
      {
        cost_code_id: null,
        description: "",
        quantity: 1,
        unit: null,
        unit_cost: 0,
        catalog_item_id: null,
        catalog_item_code: null,
      },
    ])
  }

  function update(i: number, patch: Partial<CostItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  function remove(i: number) {
    setCatalogOpenIdx(null)
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
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((ci, i) => {
                const lineTotal = (ci.quantity || 0) * (ci.unit_cost || 0)
                return (
                  <Fragment key={i}>
                  <tr className="align-top">
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
                      {ci.catalog_item_id && (
                        <CatalogCodeChip
                          code={ci.catalog_item_code}
                          onClear={() =>
                            update(i, {
                              catalog_item_id: null,
                              catalog_item_code: null,
                            })
                          }
                        />
                      )}
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
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() =>
                            setCatalogOpenIdx(catalogOpenIdx === i ? null : i)
                          }
                          className={cn(
                            "p-1 cursor-pointer",
                            ci.catalog_item_id
                              ? "text-brand-600"
                              : "text-muted hover:text-brand-600"
                          )}
                          title="Link to SpecMagician catalog"
                          aria-label="Link to SpecMagician catalog"
                        >
                          <BookMarked className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="text-muted hover:text-danger p-1 cursor-pointer"
                          aria-label="Remove line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {catalogOpenIdx === i && (
                    <tr>
                      <td colSpan={7} className="pb-1.5">
                        <CatalogLinkSearch
                          onPick={(item) => {
                            update(i, catalogPatch(item))
                            setCatalogOpenIdx(null)
                          }}
                          onClose={() => setCatalogOpenIdx(null)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
  const [viewing, setViewing] = useState(false)
  return (
    <div className="relative group">
      <div className="aspect-square rounded-md overflow-hidden border border-border bg-background flex items-center justify-center">
        {isImage && att.preview_url ? (
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="h-full w-full cursor-zoom-in"
            aria-label={`View ${att.file_name} larger`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={att.preview_url}
              alt={att.file_name}
              className="h-full w-full object-cover"
            />
          </button>
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
          className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-1.5 sm:p-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 cursor-pointer"
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
        className="mt-1 text-[11px] h-9 sm:h-7 px-2"
      />
      {viewing && att.preview_url && (
        <Lightbox
          url={att.preview_url}
          name={att.file_name}
          onClose={() => setViewing(false)}
        />
      )}
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

// Inline footer for "Create PO…" on an approved decision — picks the vendor
// the draft PO goes to. Preselects the assigned company when the decision has
// exactly one company assignment. Same inline-not-nested-Dialog pattern as
// CopyDecisionFooter.
function CreatePoFooter({
  companies,
  assignments,
  pending,
  onCancel,
  onCreate,
}: {
  companies: DecisionsData["companies"]
  assignments: AssignmentDraft[]
  pending: boolean
  onCancel: () => void
  onCreate: (companyId: string) => void
}) {
  const assignedCompanyIds = assignments
    .map((a) => a.company_id)
    .filter((x): x is string => !!x)
  // POs go to subs/vendors only (the server enforces the same rule).
  const vendorCompanies = companies.filter(
    (c) => c.type === "sub" || c.type === "vendor"
  )
  const [companyId, setCompanyId] = useState(
    assignedCompanyIds.length === 1 &&
      vendorCompanies.some((c) => c.id === assignedCompanyIds[0])
      ? assignedCompanyIds[0]
      : ""
  )
  return (
    <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <Label className="mb-1">Create a draft PO for…</Label>
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">— Pick a sub/vendor —</option>
          {vendorCompanies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[11px] text-muted">
          Line items copy from the approved cost breakdown at raw cost — markup
          never reaches the sub.
        </p>
      </div>
      <div className="flex items-center gap-2 sm:self-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => onCreate(companyId)}
          disabled={pending || !companyId}
        >
          <FileText className="h-4 w-4" />
          {pending ? "Creating…" : "Create PO"}
        </Button>
      </div>
    </DialogFooter>
  )
}

// Staff editor for who a selection is assigned to — people, companies, or
// project roles. Chips + a single "Add…" select; the set is saved wholesale
// by saveDecision.
function AssignmentsEditor({
  value,
  onChange,
  profiles,
  companies,
  roles,
  roleMembers,
}: {
  value: AssignmentDraft[]
  onChange: (v: AssignmentDraft[]) => void
  profiles: DecisionsData["profiles"]
  companies: DecisionsData["companies"]
  roles: DecisionsData["roles"]
  roleMembers: DecisionsData["roleMembers"]
}) {
  // Local resolver — resolveRoleLabel in components/schedule/helpers.ts wants
  // ScheduleData's wider picks (profiles.company_id, companies.phone), which
  // DecisionsData doesn't carry.
  function label(a: AssignmentDraft): string {
    if (a.profile_id) {
      const p = profiles.find((x) => x.id === a.profile_id)
      return p ? p.full_name || p.email || "Unknown" : "Unknown person"
    }
    if (a.company_id) {
      return (
        companies.find((x) => x.id === a.company_id)?.name ?? "Unknown company"
      )
    }
    if (a.role_id) {
      const role = roles.find((r) => r.id === a.role_id)
      const member = roleMembers.find((m) => m.role_id === a.role_id)
      let who = "unassigned"
      if (member?.profile_id) {
        const p = profiles.find((x) => x.id === member.profile_id)
        if (p) who = p.full_name || p.email || "unassigned"
      } else if (member?.company_id) {
        const c = companies.find((x) => x.id === member.company_id)
        if (c) who = c.name
      }
      return `${role?.name ?? "Role"} (${who})`
    }
    return "Unknown"
  }

  // Alphabetize each picker group — the roles catalog arrives in manual
  // `position` order, and sorting people/companies too keeps every list A–Z.
  const staffProfiles = profiles
    .filter((p) => p.role === "staff")
    .sort((a, b) =>
      (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "")
    )
  const sortedCompanies = [...companies].sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  const sortedRoles = [...roles].sort((a, b) => a.name.localeCompare(b.name))

  function addFromValue(v: string) {
    if (!v) return
    const next: AssignmentDraft = {
      profile_id: v.startsWith("p:") ? v.slice(2) : null,
      company_id: v.startsWith("c:") ? v.slice(2) : null,
      role_id: v.startsWith("r:") ? v.slice(2) : null,
    }
    const dup = value.some(
      (a) =>
        a.profile_id === next.profile_id &&
        a.company_id === next.company_id &&
        a.role_id === next.role_id
    )
    if (dup) return
    onChange([...value, next])
  }

  return (
    <div>
      <Label>
        <Users className="inline h-3 w-3 mr-1 text-brand-500" />
        Assigned to
      </Label>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {value.map((a, i) => (
          <span
            key={`${a.profile_id ?? ""}:${a.company_id ?? ""}:${a.role_id ?? ""}`}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
          >
            {label(a)}
            <button
              type="button"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              className="text-muted hover:text-danger cursor-pointer"
              aria-label={`Remove ${label(a)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {/* Always-empty controlled value = the select resets after each add. */}
        <Select
          value=""
          onChange={(e) => addFromValue(e.target.value)}
          className="h-7 w-auto text-xs"
          aria-label="Add assignee"
        >
          <option value="">Add…</option>
          <optgroup label="People">
            {staffProfiles.map((p) => (
              <option key={p.id} value={`p:${p.id}`}>
                {p.full_name || p.email}
              </option>
            ))}
          </optgroup>
          <optgroup label="Companies">
            {sortedCompanies.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Roles">
            {sortedRoles.map((r) => (
              <option key={r.id} value={`r:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        </Select>
      </div>
      <p className="text-xs text-muted mt-1.5">
        Assigned subs can see this selection in their portal once it leaves
        draft.
      </p>
    </div>
  )
}

// Maps a picked catalog item onto a cost line: description always copies,
// unit/unit cost only when the catalog has them (cost falls back to the
// suggested price), plus the link itself.
function catalogPatch(item: CatalogItemHit): Partial<CostItem> {
  const cents = item.unit_cost_cents ?? item.suggested_price_cents
  return {
    description: item.description,
    ...(item.unit ? { unit: item.unit } : {}),
    ...(cents != null ? { unit_cost: cents / 100 } : {}),
    catalog_item_id: item.id,
    catalog_item_code: item.code,
  }
}

// "vendor · unit · cost $X.XX (suggested $Y.YY)" with missing parts omitted.
function catalogHitMeta(h: CatalogItemHit): string {
  const parts: string[] = []
  if (h.vendor) parts.push(h.vendor)
  if (h.unit) parts.push(h.unit)
  if (h.unit_cost_cents != null) {
    let cost = `cost ${formatCurrency(h.unit_cost_cents / 100)}`
    if (h.suggested_price_cents != null) {
      cost += ` (suggested ${formatCurrency(h.suggested_price_cents / 100)})`
    }
    parts.push(cost)
  } else if (h.suggested_price_cents != null) {
    parts.push(`suggested ${formatCurrency(h.suggested_price_cents / 100)}`)
  }
  return parts.join(" · ")
}

// Tiny "linked to catalog" marker on a cost line. The × clears only the link;
// the copied description/cost stay put.
function CatalogCodeChip({
  code,
  onClear,
}: {
  code: string | null
  onClear: () => void
}) {
  return (
    <span
      title="Linked to catalog item"
      className="mt-1 inline-flex items-center gap-1 rounded border border-border bg-background px-1 py-0.5 text-[10px] font-mono text-muted"
    >
      <BookMarked className="h-2.5 w-2.5 text-brand-500" />
      {code || "linked"}
      <button
        type="button"
        onClick={onClear}
        className="hover:text-danger cursor-pointer"
        aria-label="Unlink from catalog"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}

// Inline search against the SpecMagician catalog — an expanding row under a
// cost line. Debounced ~300ms; picking a hit copies its fields onto the line.
function CatalogLinkSearch({
  onPick,
  onClose,
}: {
  onPick: (item: CatalogItemHit) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<CatalogItemHit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = query.trim()
    let cancelled = false
    // Every setState goes through the debounce timer — nothing synchronous in
    // the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(async () => {
      if (q.length < 2) {
        if (!cancelled) {
          setHits([])
          setError(null)
          setSearching(false)
        }
        return
      }
      if (!cancelled) setSearching(true)
      try {
        const r = await searchCatalogItems({ query: q })
        if (cancelled) return
        if (r.ok) {
          setHits(r.items)
          setError(null)
        } else {
          setHits([])
          // Covers the "SpecMagician not configured" case too.
          setError(r.error)
        }
      } catch (e) {
        if (!cancelled) {
          setHits([])
          setError(actionErrorMessage(e, "Search failed"))
        }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  return (
    <div className="rounded border border-border bg-surface p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the SpecMagician catalog (code, description, vendor)"
          className="h-8 text-xs"
        />
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-foreground p-1 cursor-pointer"
          aria-label="Close catalog search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {query.trim().length < 2 ? (
        <p className="text-[11px] text-muted">
          Type at least 2 characters to search.
        </p>
      ) : error ? (
        <p className="text-xs text-danger max-h-24 overflow-y-auto break-words whitespace-pre-wrap">
          {error}
        </p>
      ) : searching && hits.length === 0 ? (
        <p className="text-[11px] text-muted">Searching…</p>
      ) : hits.length === 0 ? (
        <p className="text-[11px] text-muted">No catalog items match.</p>
      ) : (
        <ul className="max-h-48 overflow-y-auto divide-y divide-border">
          {hits.map((h) => {
            const meta = catalogHitMeta(h)
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => onPick(h)}
                  className="w-full text-left rounded px-1.5 py-1.5 hover:bg-background cursor-pointer"
                >
                  <span className="block text-xs">
                    <span className="font-mono">{h.code}</span> —{" "}
                    {h.description}
                  </span>
                  {meta && (
                    <span className="block text-[11px] text-muted">{meta}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Full-screen photo viewer for the drawer's image thumbnails. Renders above
// the drawer dialog (z-50 → z-[70]); click anywhere or Escape closes. The
// Escape listener runs in the capture phase and stops propagation so the
// Dialog's own document-level Escape handler doesn't close the whole drawer.
function Lightbox({
  url,
  name,
  onClose,
}: {
  url: string
  name: string
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onClose])
  return (
    <div
      role="dialog"
      aria-label={name}
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4 sm:p-8 cursor-zoom-out"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        className="max-h-full max-w-full object-contain rounded-md shadow-2xl"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute top-3 right-3 rounded-full bg-black/60 text-white p-2 hover:bg-black/80 cursor-pointer"
        aria-label="Close photo"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}
