"use client"

import { useState, useTransition, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  Send,
  Upload,
  FileIcon,
  Lock,
  RefreshCcw,
  Ban,
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
import { cn, formatDate } from "@/lib/utils"
import {
  saveBidPackage,
  sendBidPackage,
  reviseBidPackage,
  closeBidPackage,
  deleteBidPackage,
  type BidPackageInputT,
} from "@/app/actions/bids"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  BidStatusBadge,
  RecipientStatusBadge,
} from "@/app/(app)/projects/[id]/bids/bids-client"
import type { Tables } from "@/lib/db/types"
import type { BidsData } from "@/app/(app)/projects/[id]/bids/bids-client"

type LineItem = {
  id?: string
  cost_code_id?: string | null
  description: string
  quantity: number
  unit?: string | null
}

type Attachment = {
  id?: string
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
  caption?: string | null
  preview_url?: string
}

export function BidPackageDrawer({
  open,
  onClose,
  pkg,
  data,
}: {
  open: boolean
  onClose: () => void
  // undefined = creating a new package.
  pkg?: Tables<"bid_packages">
  data: BidsData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)

  const status = pkg?.status ?? "draft"
  const isDraft = status === "draft"

  const [title, setTitle] = useState(pkg?.title ?? "")
  const [scope, setScope] = useState(pkg?.scope ?? "")
  const [dueDate, setDueDate] = useState<string>(pkg?.due_date ?? "")
  const [flatFee, setFlatFee] = useState(pkg?.flat_fee ?? false)
  const [allowMultiple, setAllowMultiple] = useState(
    pkg?.allow_multiple_awards ?? false
  )
  const [lineItems, setLineItems] = useState<LineItem[]>(() => {
    if (!pkg) return []
    return data.line_items
      .filter((li) => li.bid_package_id === pkg.id)
      .map((li) => ({
        id: li.id,
        cost_code_id: li.cost_code_id,
        description: li.description,
        quantity: Number(li.quantity),
        unit: li.unit,
      }))
  })
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    if (!pkg) return []
    return data.attachments
      .filter((a) => a.bid_package_id === pkg.id)
      .map((a) => ({
        id: a.id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
        preview_url: data.signed_urls[a.storage_path],
      }))
  })

  const recipients = pkg
    ? data.recipients.filter((r) => r.bid_package_id === pkg.id)
    : []
  const existingCompanyIds = new Set(recipients.map((r) => r.company_id))
  // Existing recipients stay checked (re-sends to those still awaiting a
  // response); staff tick additional companies to invite.
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(
    () => new Set(existingCompanyIds)
  )

  const submittedCount = recipients.filter(
    (r) => r.status === "submitted" || r.status === "awarded"
  ).length

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const newAtts: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${data.project_id}/bids/${Date.now()}-${Math.random()
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
          storage_path: path,
          file_name: file.name,
          file_type: file.type || null,
          file_size: file.size,
          preview_url: URL.createObjectURL(file),
        })
      }
      if (newAtts.length) {
        setAttachments((current) => [...current, ...newAtts])
        toast.success(
          `${newAtts.length} file${newAtts.length === 1 ? "" : "s"} uploaded`
        )
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function buildPayload(): BidPackageInputT | null {
    if (!title.trim()) {
      toast.error("Title is required")
      return null
    }
    return {
      id: pkg?.id,
      project_id: data.project_id,
      title: title.trim(),
      scope: scope || null,
      due_date: dueDate || null,
      flat_fee: flatFee,
      allow_multiple_awards: allowMultiple,
      line_items: flatFee
        ? []
        : lineItems
            .filter((li) => li.description.trim() !== "")
            .map((li) => ({
              id: li.id,
              cost_code_id: li.cost_code_id || null,
              description: li.description.trim(),
              quantity: li.quantity,
              unit: li.unit || null,
            })),
      attachments: attachments.map((a) => ({
        id: a.id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
      })),
    }
  }

  function handleSave(sendAfter: boolean) {
    const payload = buildPayload()
    if (!payload) return
    const companyIds = [...selectedCompanyIds]
    if (sendAfter && companyIds.length === 0) {
      toast.error("Pick at least one sub/vendor to send to.")
      return
    }
    startTransition(async () => {
      try {
        const { id } = await saveBidPackage(payload)
        if (sendAfter) {
          const { sent } = await sendBidPackage({
            id,
            project_id: data.project_id,
            company_ids: companyIds,
          })
          toast.success(
            `Sent to ${sent} compan${sent === 1 ? "y" : "ies"}`
          )
        } else {
          toast.success(pkg ? "Saved" : "Draft created")
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  // Sent packages: re-send to existing invitees and/or invite newly ticked
  // companies. Metadata (title/scope/due) is saved first so the links show
  // the latest wording.
  function handleResend() {
    if (!pkg) return
    const payload = buildPayload()
    if (!payload) return
    const companyIds = [...selectedCompanyIds]
    if (companyIds.length === 0) {
      toast.error("Pick at least one sub/vendor.")
      return
    }
    startTransition(async () => {
      try {
        await saveBidPackage(payload)
        const { sent } = await sendBidPackage({
          id: pkg.id,
          project_id: data.project_id,
          company_ids: companyIds,
        })
        toast.success(`Sent to ${sent} compan${sent === 1 ? "y" : "ies"}`)
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Send failed")
      }
    })
  }

  function handleRevise() {
    if (!pkg) return
    const payload = buildPayload()
    if (!payload) return
    if (
      !confirm(
        `This clears all ${submittedCount} submitted response${
          submittedCount === 1 ? "" : "s"
        } and asks everyone to re-bid against the updated scope. Continue?`
      )
    )
      return
    startTransition(async () => {
      try {
        const { reset } = await reviseBidPackage(payload)
        toast.success(
          `Revised — ${reset} recipient${reset === 1 ? "" : "s"} asked to re-bid`
        )
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Revise failed")
      }
    })
  }

  function handleCloseBidding() {
    if (!pkg) return
    if (
      !confirm(
        "Close bidding? All recipient links stop working and no further bids can be submitted."
      )
    )
      return
    startTransition(async () => {
      try {
        await closeBidPackage({ id: pkg.id, project_id: data.project_id })
        toast.success("Bidding closed")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Close failed")
      }
    })
  }

  function handleDelete() {
    if (!pkg) return
    const warn =
      submittedCount > 0
        ? `Delete this bid request? ${submittedCount} submitted response${
            submittedCount === 1 ? "" : "s"
          } will be permanently lost.`
        : "Delete this bid request and its attachments?"
    if (!confirm(warn)) return
    startTransition(async () => {
      try {
        await deleteBidPackage({ id: pkg.id, project_id: data.project_id })
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <div className="flex items-center gap-2 mb-1">
              {pkg && (
                <span className="text-xs font-mono text-muted">
                  BID-{pkg.number}
                </span>
              )}
              <BidStatusBadge status={status} />
              {dueDate && (
                <span className="text-xs text-muted">
                  Due {formatDate(dueDate)}
                </span>
              )}
            </div>
            <DialogTitle>
              {pkg ? pkg.title : "New bid request"}
            </DialogTitle>
            <DialogDescription>
              Send a scope to multiple subs/vendors — each gets a private link
              to price it, no login needed.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Framing labor — main house"
            />
          </Field>
          <Field label="Scope">
            <Textarea
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              rows={4}
              placeholder="What's included, exclusions, site conditions, timing."
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Bids due" hint="Shown to the subs in the request.">
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          </div>

          <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
            <label
              className={cn(
                "flex items-start gap-2 text-sm",
                isDraft ? "cursor-pointer" : "opacity-60"
              )}
            >
              <input
                type="checkbox"
                checked={flatFee}
                disabled={!isDraft}
                onChange={(e) => setFlatFee(e.target.checked)}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                <span className="font-medium">Flat fee</span>
                <span className="block text-xs text-muted">
                  Subs enter one total instead of pricing line items.
                </span>
              </span>
            </label>
            <label
              className={cn(
                "flex items-start gap-2 text-sm",
                isDraft ? "cursor-pointer" : "opacity-60"
              )}
            >
              <input
                type="checkbox"
                checked={allowMultiple}
                disabled={!isDraft}
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
            {!isDraft && (
              <p className="text-[11px] text-muted inline-flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Pricing structure is frozen after sending — use Revise &amp;
                re-request to change it.
              </p>
            )}
          </div>

          {!flatFee && (
            <BidLineItemsEditor
              items={lineItems}
              onChange={setLineItems}
              costCodes={data.cost_codes}
              frozen={!isDraft}
            />
          )}

          {/* Attachments */}
          <div>
            <Label>Plans &amp; files</Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => uploadFiles(e.target.files)}
            />
            <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {attachments.map((a) => (
                <div key={a.storage_path} className="relative group">
                  <div className="aspect-square rounded-md overflow-hidden border border-border bg-background flex items-center justify-center">
                    {a.file_type?.startsWith("image/") && a.preview_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.preview_url}
                        alt={a.file_name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex flex-col items-center text-muted text-[10px] p-1">
                        <FileIcon className="h-6 w-6 mb-1" />
                        <span
                          className="truncate w-full text-center"
                          title={a.file_name}
                        >
                          {a.file_name}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter(
                          (x) => x.storage_path !== a.storage_path
                        )
                      )
                    }
                    className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 cursor-pointer"
                    aria-label="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="aspect-square rounded-md border border-dashed border-border-strong flex flex-col items-center justify-center text-muted hover:border-brand-500 hover:text-brand-600 cursor-pointer text-xs gap-1 disabled:opacity-50"
              >
                <Upload className="h-5 w-5" />
                {uploading ? "Uploading…" : "Add files"}
              </button>
            </div>
          </div>

          {/* Recipients */}
          {status !== "closed" && (
            <RecipientPicker
              companies={data.companies}
              companyTrades={data.company_trades}
              recipients={recipients}
              selected={selectedCompanyIds}
              onToggle={(companyId) =>
                setSelectedCompanyIds((current) => {
                  const next = new Set(current)
                  if (next.has(companyId)) next.delete(companyId)
                  else next.add(companyId)
                  return next
                })
              }
            />
          )}
        </DialogBody>
        <DialogFooter>
          {pkg && (
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
          {isDraft ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => handleSave(false)}
                disabled={pending || uploading}
              >
                {pending ? "Saving…" : "Save draft"}
              </Button>
              <Button
                type="button"
                onClick={() => handleSave(true)}
                disabled={pending || uploading}
              >
                <Send className="h-4 w-4" /> Save &amp; send
              </Button>
            </>
          ) : status === "sent" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={handleCloseBidding}
                disabled={pending}
              >
                <Ban className="h-4 w-4" /> Close bidding
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleRevise}
                disabled={pending || uploading}
              >
                <RefreshCcw className="h-4 w-4" /> Revise &amp; re-request
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleResend}
                disabled={pending || uploading}
              >
                <Send className="h-4 w-4" /> Add recipients / Resend
              </Button>
              <Button
                type="button"
                onClick={() => handleSave(false)}
                disabled={pending || uploading}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            // awarded / closed — metadata edits only.
            <Button
              type="button"
              onClick={() => handleSave(false)}
              disabled={pending || uploading}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Line-item editor without a unit-cost column — the sub supplies pricing via
 * their quotes. Frozen (read-only) once the package has been sent.
 */
function BidLineItemsEditor({
  items,
  onChange,
  costCodes,
  frozen,
}: {
  items: LineItem[]
  onChange: (v: LineItem[]) => void
  costCodes: BidsData["cost_codes"]
  frozen: boolean
}) {
  function add() {
    onChange([
      ...items,
      { cost_code_id: null, description: "", quantity: 1, unit: null },
    ])
  }
  function update(i: number, patch: Partial<LineItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }
  return (
    <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label>Line items</Label>
        <span className="text-[11px] text-muted">
          {frozen
            ? "Frozen — subs are pricing against these lines."
            : "Subs price each line; you compare unit costs side by side."}
        </span>
      </div>
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left font-medium pb-1.5 w-[30%]">
                  Cost code
                </th>
                <th className="text-left font-medium pb-1.5">Description</th>
                <th className="text-right font-medium pb-1.5 w-20">Qty</th>
                <th className="text-left font-medium pb-1.5 w-16">Unit</th>
                {!frozen && <th className="w-6"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((li, i) => (
                <tr key={li.id ?? `new-${i}`} className="align-top">
                  <td className="pr-1.5 pb-1.5">
                    <Select
                      value={li.cost_code_id ?? ""}
                      disabled={frozen}
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
                      value={li.description}
                      disabled={frozen}
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
                      value={li.quantity}
                      disabled={frozen}
                      onChange={(e) =>
                        update(i, { quantity: Number(e.target.value) || 0 })
                      }
                    />
                  </td>
                  <td className="pr-1.5 pb-1.5">
                    <Input
                      value={li.unit ?? ""}
                      disabled={frozen}
                      onChange={(e) => update(i, { unit: e.target.value })}
                      placeholder="ea"
                    />
                  </td>
                  {!frozen && (
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
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!frozen && (
        <button
          type="button"
          onClick={add}
          className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
        >
          <Plus className="h-3 w-3" /> Add line
        </button>
      )}
    </div>
  )
}

/**
 * Multi-select of sub/vendor companies. Companies already invited stay
 * checked and locked — including them in a send just re-sends to those who
 * haven't responded yet.
 */
function RecipientPicker({
  companies,
  companyTrades,
  recipients,
  selected,
  onToggle,
}: {
  companies: BidsData["companies"]
  companyTrades: BidsData["company_trades"]
  recipients: BidsData["recipients"]
  selected: Set<string>
  onToggle: (companyId: string) => void
}) {
  const byCompany = new Map(recipients.map((r) => [r.company_id, r]))
  return (
    <div>
      <Label>Send to</Label>
      <p className="text-xs text-muted mt-0.5">
        Each company gets its own private bid link by email/SMS. They never see
        competitors&apos; pricing.
      </p>
      {companies.length === 0 ? (
        <p className="text-xs text-muted mt-2">
          No sub/vendor companies yet — add them on the Companies page first.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto rounded-md border border-border p-2">
          {companies.map((c) => {
            const existing = byCompany.get(c.id)
            const trades = companyTrades
              .filter((t) => t.company_id === c.id)
              .map((t) => t.trade)
            return (
              <li key={c.id}>
                <label
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1 text-sm",
                    existing ? "opacity-80" : "cursor-pointer hover:bg-background/60"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    disabled={!!existing}
                    onChange={() => onToggle(c.id)}
                    className="accent-brand-500"
                  />
                  <span className="font-medium">{c.name}</span>
                  {trades.map((t) => (
                    <Badge key={t} tone="muted">
                      {t}
                    </Badge>
                  ))}
                  {existing && (
                    <span className="ml-auto">
                      <RecipientStatusBadge status={existing.status} />
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
