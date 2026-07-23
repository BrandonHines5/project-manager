"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, X, Trash2, Gavel, FileText } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Select, Label } from "@/components/ui/input"
import { ScopeEditor } from "@/components/purchasing/scope-editor"
import { Button } from "@/components/ui/button"
import { cn, formatCurrency } from "@/lib/utils"
import { saveBidPackage } from "@/app/actions/bids"
import { savePurchaseOrder } from "@/app/actions/purchase-orders"
import {
  deletePurchasingTemplate,
  type PurchasingTemplateRow,
} from "@/app/actions/purchasing-templates"
import type { Tables } from "@/lib/db/types"

type Kind = "bid" | "po"

type Line = {
  cost_code_id: string | null
  description: string
  quantity: number
  unit: string | null
  // Kept in state across the toggle; only sent (or shown) in PO mode.
  unit_cost: number
}

/**
 * One create form for both record types — a Bid request / Purchase order
 * toggle stays live until the first save, and everything typed (title, scope,
 * lines) survives switching sides. On create it dispatches to the matching
 * server action and deep-links into the full drawer (recipients, attachments,
 * release all live there). Templates prefill the shared fields and work as
 * either kind: bid mode ignores unit costs, PO mode defaults missing ones
 * to 0.
 */
export function NewPurchasingDialog({
  open,
  onClose,
  projectId,
  companies,
  costCodes,
  templates,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  companies: Pick<Tables<"companies">, "id" | "name">[]
  costCodes: Pick<
    Tables<"cost_codes">,
    "id" | "code" | "name" | "position" | "is_active"
  >[]
  templates: PurchasingTemplateRow[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [kind, setKind] = useState<Kind>("bid")
  const [templateId, setTemplateId] = useState("")
  const [title, setTitle] = useState("")
  const [scope, setScope] = useState("")
  const [flatFee, setFlatFee] = useState(false)
  const [flatTotal, setFlatTotal] = useState("")
  const [lines, setLines] = useState<Line[]>([])
  // Bid-only
  const [dueDate, setDueDate] = useState("")
  const [allowMultiple, setAllowMultiple] = useState(false)
  // PO-only
  const [companyId, setCompanyId] = useState("")
  const [customNumber, setCustomNumber] = useState("")
  const [approvalDeadline, setApprovalDeadline] = useState("")

  // A backdrop click or stray Cancel must not eat a half-typed form — same
  // dirty-confirm pattern as the drawers. Kind/template selection alone
  // isn't worth guarding; typed content is.
  const dirty =
    title.trim() !== "" ||
    scope.trim() !== "" ||
    lines.some((li) => li.description.trim() !== "") ||
    flatTotal !== "" ||
    customNumber !== ""

  function requestClose() {
    if (dirty && !confirm("Discard this unsaved form?")) return
    onClose()
  }

  function applyTemplate(id: string) {
    setTemplateId(id)
    const t = templates.find((x) => x.id === id)
    if (!t) return
    setTitle(t.title)
    setScope(t.scope ?? "")
    setFlatFee(t.flat_fee)
    setLines(
      t.line_items.map((li) => ({
        cost_code_id: li.cost_code_id ?? null,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit ?? null,
        unit_cost: li.unit_cost ?? 0,
      }))
    )
  }

  function handleDeleteTemplate() {
    const t = templates.find((x) => x.id === templateId)
    if (!t) return
    if (!confirm(`Delete the template “${t.name}”? This can't be undone.`)) return
    startTransition(async () => {
      try {
        await deletePurchasingTemplate(t.id, projectId)
        setTemplateId("")
        toast.success("Template deleted")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  function handleCreate() {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    if (kind === "po" && !companyId) {
      toast.error("Pick a sub/vendor")
      return
    }
    if (kind === "po" && flatFee && flatTotal === "") {
      toast.error("Enter the flat-fee amount")
      return
    }
    const effectiveLines = lines.filter((li) => li.description.trim() !== "")
    startTransition(async () => {
      try {
        if (kind === "bid") {
          const { id } = await saveBidPackage({
            project_id: projectId,
            title: title.trim(),
            scope: scope || null,
            due_date: dueDate || null,
            flat_fee: flatFee,
            allow_multiple_awards: allowMultiple,
            line_items: flatFee
              ? []
              : effectiveLines.map((li) => ({
                  cost_code_id: li.cost_code_id,
                  description: li.description.trim(),
                  quantity: li.quantity,
                  unit: li.unit,
                })),
            attachments: [],
          })
          toast.success("Draft bid request created")
          router.push(`/projects/${projectId}/purchasing?tab=bids&open=${id}`)
        } else {
          const { id } = await savePurchaseOrder({
            project_id: projectId,
            title: title.trim(),
            scope: scope || null,
            company_id: companyId,
            custom_number: customNumber || null,
            approval_deadline: approvalDeadline || null,
            flat_fee: flatFee,
            flat_total: flatFee ? Number(flatTotal) : null,
            line_items: flatFee
              ? []
              : effectiveLines.map((li) => ({
                  cost_code_id: li.cost_code_id,
                  description: li.description.trim(),
                  quantity: li.quantity,
                  unit: li.unit,
                  unit_cost: li.unit_cost,
                })),
            attachments: [],
          })
          toast.success("Draft PO created")
          router.push(`/projects/${projectId}/purchasing?tab=pos&open=${id}`)
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Create failed")
      }
    })
  }

  const runningTotal = effectiveTotal(kind, flatFee, flatTotal, lines)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && requestClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <DialogTitle>New bid request / purchase order</DialogTitle>
            <DialogDescription>
              Same form either way — flip the toggle any time before creating;
              what you&apos;ve typed carries over.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {/* Kind toggle */}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Record type">
            <button
              type="button"
              role="radio"
              aria-checked={kind === "bid"}
              onClick={() => setKind("bid")}
              className={cn(
                "rounded-md border p-3 text-left text-sm transition-colors cursor-pointer",
                kind === "bid"
                  ? "border-brand-500 bg-brand-50/60"
                  : "border-border hover:border-border-strong"
              )}
            >
              <span className="font-medium inline-flex items-center gap-1.5">
                <Gavel className="h-4 w-4" /> Bid request
              </span>
              <span className="block text-xs text-muted mt-0.5">
                Multiple subs price the scope; you compare and award.
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === "po"}
              onClick={() => setKind("po")}
              className={cn(
                "rounded-md border p-3 text-left text-sm transition-colors cursor-pointer",
                kind === "po"
                  ? "border-brand-500 bg-brand-50/60"
                  : "border-border hover:border-border-strong"
              )}
            >
              <span className="font-medium inline-flex items-center gap-1.5">
                <FileText className="h-4 w-4" /> Purchase order
              </span>
              <span className="block text-xs text-muted mt-0.5">
                One sub/vendor approves a priced scope via a private link.
              </span>
            </button>
          </div>

          {/* Template */}
          {templates.length > 0 && (
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <Field
                  label="Start from template"
                  hint="Prefills title, scope and line items — pricing applies in PO mode."
                >
                  <Select
                    value={templateId}
                    onChange={(e) => applyTemplate(e.target.value)}
                  >
                    <option value="">— Blank —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {templateId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDeleteTemplate}
                  disabled={pending}
                  className="text-danger hover:bg-red-50"
                  title="Delete this template"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}

          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                kind === "bid" ? "Framing labor — main house" : "Plumbing rough-in"
              }
            />
          </Field>
          <Field label="Scope">
            <ScopeEditor
              value={scope}
              onChange={setScope}
              rows={4}
              placeholder="What's included, exclusions, site conditions, timing."
            />
          </Field>

          {kind === "bid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Bids due" hint="Shown to the subs in the request.">
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Sub / vendor">
                  <Select
                    value={companyId}
                    onChange={(e) => setCompanyId(e.target.value)}
                  >
                    <option value="">— Select —</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Custom PO #"
                  hint="Optional — shown alongside the sequential number."
                >
                  <Input
                    value={customNumber}
                    onChange={(e) => setCustomNumber(e.target.value)}
                    placeholder="2024-118"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label="Approval deadline"
                  hint="The sub is asked to approve by this date."
                >
                  <Input
                    type="date"
                    value={approvalDeadline}
                    onChange={(e) => setApprovalDeadline(e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}

          <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={flatFee}
                onChange={(e) => setFlatFee(e.target.checked)}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                <span className="font-medium">Flat fee</span>
                <span className="block text-xs text-muted">
                  {kind === "bid"
                    ? "Subs enter one total instead of pricing line items."
                    : "One total, no line items."}
                </span>
              </span>
            </label>
            {flatFee && kind === "bid" && (
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowMultiple}
                  onChange={(e) => setAllowMultiple(e.target.checked)}
                  className="mt-0.5 accent-brand-500"
                />
                <span className="text-xs text-muted">Allow multiple awards</span>
              </label>
            )}
            {flatFee && kind === "po" && (
              <Field label="Flat total">
                <Input
                  type="number"
                  step="0.01"
                  value={flatTotal}
                  onChange={(e) => setFlatTotal(e.target.value)}
                  placeholder="0.00"
                  className="w-40 text-right tabular-nums"
                />
              </Field>
            )}
          </div>
          {!flatFee && kind === "bid" && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={allowMultiple}
                onChange={(e) => setAllowMultiple(e.target.checked)}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                <span className="font-medium">Allow multiple awards</span>
                <span className="block text-xs text-muted">
                  Keep the package open for more awards after the first (e.g.
                  splitting the scope between subs).
                </span>
              </span>
            </label>
          )}

          {!flatFee && (
            <SharedLinesEditor
              lines={lines}
              onChange={setLines}
              costCodes={costCodes}
              showUnitCost={kind === "po"}
              total={runningTotal}
            />
          )}

          <p className="text-xs text-muted">
            Recipients, attachments and sending live in the full editor — it
            opens right after you create the draft.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={pending}>
            <Plus className="h-4 w-4" />
            {pending
              ? "Creating…"
              : kind === "bid"
                ? "Create bid request"
                : "Create purchase order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function effectiveTotal(
  kind: Kind,
  flatFee: boolean,
  flatTotal: string,
  lines: Line[]
): number | null {
  if (kind !== "po") return null
  if (flatFee) return flatTotal === "" ? null : Number(flatTotal)
  return lines
    .filter((li) => li.description.trim() !== "")
    .reduce(
      (sum, li) => sum + (Number(li.quantity) || 0) * (Number(li.unit_cost) || 0),
      0
    )
}

/**
 * Minimal line editor for the create form: bid mode hides the unit-cost
 * column (subs price bids) but keeps any entered costs in state so toggling
 * to PO mode brings them back.
 */
function SharedLinesEditor({
  lines,
  onChange,
  costCodes,
  showUnitCost,
  total,
}: {
  lines: Line[]
  onChange: (v: Line[]) => void
  costCodes: Pick<
    Tables<"cost_codes">,
    "id" | "code" | "name" | "position" | "is_active"
  >[]
  showUnitCost: boolean
  total: number | null
}) {
  function update(i: number, patch: Partial<Line>) {
    onChange(lines.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  return (
    <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label>Line items</Label>
        <span className="text-[11px] text-muted">
          {showUnitCost
            ? "Priced by you — the sub approves the total."
            : "Subs price each line; you compare side by side."}
        </span>
      </div>
      {lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left font-medium pb-1.5 w-[28%]">Cost code</th>
                <th className="text-left font-medium pb-1.5">Description</th>
                <th className="text-right font-medium pb-1.5 w-20">Qty</th>
                <th className="text-left font-medium pb-1.5 w-16">Unit</th>
                {showUnitCost && (
                  <th className="text-right font-medium pb-1.5 w-28">Unit cost</th>
                )}
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((li, i) => (
                <tr key={`line-${i}`} className="align-top">
                  <td className="pr-1.5 pb-1.5">
                    <Select
                      value={li.cost_code_id ?? ""}
                      onChange={(e) =>
                        update(i, { cost_code_id: e.target.value || null })
                      }
                    >
                      <option value="">— Select —</option>
                      {li.cost_code_id &&
                        !costCodes.some((c) => c.id === li.cost_code_id) && (
                          <option value={li.cost_code_id}>(inactive code)</option>
                        )}
                      {costCodes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="pr-1.5 pb-1.5">
                    <Input
                      value={li.description}
                      onChange={(e) => update(i, { description: e.target.value })}
                      placeholder="Detail"
                    />
                  </td>
                  <td className="pr-1.5 pb-1.5">
                    <Input
                      type="number"
                      step="0.01"
                      className="text-right tabular-nums"
                      value={li.quantity}
                      onChange={(e) =>
                        update(i, { quantity: Number(e.target.value) || 0 })
                      }
                    />
                  </td>
                  <td className="pr-1.5 pb-1.5">
                    <Input
                      value={li.unit ?? ""}
                      onChange={(e) => update(i, { unit: e.target.value })}
                      placeholder="ea"
                    />
                  </td>
                  {showUnitCost && (
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={li.unit_cost}
                        onChange={(e) =>
                          update(i, { unit_cost: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                  )}
                  <td className="pb-1.5 pt-2">
                    <button
                      type="button"
                      onClick={() => onChange(lines.filter((_, idx) => idx !== i))}
                      className="text-muted hover:text-danger p-1 cursor-pointer"
                      aria-label="Remove line"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() =>
            onChange([
              ...lines,
              {
                cost_code_id: null,
                description: "",
                quantity: 1,
                unit: null,
                unit_cost: 0,
              },
            ])
          }
          className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
        >
          <Plus className="h-3 w-3" /> Add line
        </button>
        {showUnitCost && total != null && (
          <span className="text-sm font-semibold font-mono tabular-nums">
            Total {formatCurrency(total)}
          </span>
        )}
      </div>
    </div>
  )
}
