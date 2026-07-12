"use client"

import { useState, useTransition, useRef } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  Send,
  Upload,
  FileIcon,
  Link2,
  PenLine,
  Undo2,
  Ban,
  CheckCircle2,
  Gavel,
  MessageSquare,
  Lock,
  Copy,
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
import { cn, formatCurrency, formatDate } from "@/lib/utils"
import {
  savePurchaseOrder,
  releasePurchaseOrder,
  unreleasePurchaseOrder,
  staffApprovePurchaseOrder,
  voidPurchaseOrder,
  setPoWorkComplete,
  deletePurchaseOrder,
  postPoCommentStaff,
  copyPurchaseOrder,
  type PurchaseOrderInputT,
} from "@/app/actions/purchase-orders"
import { pushPurchaseOrderToQbo } from "@/app/actions/quickbooks"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { PoStatusBadge } from "@/app/(app)/projects/[id]/purchase-orders/purchase-orders-client"
import type { Tables } from "@/lib/db/types"
import type { PurchaseOrdersData } from "@/app/(app)/projects/[id]/purchase-orders/purchase-orders-client"

type LineItem = {
  id?: string
  cost_code_id?: string | null
  description: string
  quantity: number
  unit?: string | null
  unit_cost: number
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

export function PoDrawer({
  open,
  onClose,
  po,
  data,
}: {
  open: boolean
  onClose: () => void
  // undefined = creating a new PO.
  po?: PurchaseOrdersData["pos"][number]
  data: PurchaseOrdersData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  // Inline "approve on behalf" footer panel (not a nested Dialog — see
  // CopyDecisionFooter for why).
  const [approveOpen, setApproveOpen] = useState(false)
  const [signerName, setSignerName] = useState("")
  const [copyOpen, setCopyOpen] = useState(false)

  function handleCopy(targetProjectId: string) {
    if (!po) return
    startTransition(async () => {
      try {
        const r = await copyPurchaseOrder({
          id: po.id,
          target_project_id: targetProjectId,
        })
        const targetProject = data.projects.find((p) => p.id === targetProjectId)
        toast.success(
          r.sameProject
            ? "Copied — new draft created in this project"
            : `Copied to ${targetProject?.project_number ?? "the selected project"}`
        )
        router.refresh()
        if (!r.sameProject) {
          router.push(`/projects/${targetProjectId}/purchase-orders`)
        }
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Copy failed")
      }
    })
  }

  const status = po?.status ?? "draft"
  const isDraft = status === "draft"

  const [title, setTitle] = useState(po?.title ?? "")
  const [customNumber, setCustomNumber] = useState(po?.custom_number ?? "")
  const [companyId, setCompanyId] = useState(po?.company_id ?? "")
  const [scope, setScope] = useState(po?.scope ?? "")
  const [approvalDeadline, setApprovalDeadline] = useState<string>(
    po?.approval_deadline ?? ""
  )
  const [flatFee, setFlatFee] = useState(po?.flat_fee ?? false)
  const [flatTotal, setFlatTotal] = useState<string>(
    po?.flat_total != null ? String(po.flat_total) : ""
  )
  const [lineItems, setLineItems] = useState<LineItem[]>(() => {
    if (!po) return []
    return data.line_items
      .filter((li) => li.purchase_order_id === po.id)
      .map((li) => ({
        id: li.id,
        cost_code_id: li.cost_code_id,
        description: li.description,
        quantity: Number(li.quantity),
        unit: li.unit,
        unit_cost: Number(li.unit_cost),
      }))
  })
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    if (!po) return []
    return data.attachments
      .filter((a) => a.purchase_order_id === po.id)
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

  const effectiveItems = lineItems.filter((li) => li.description.trim() !== "")
  const runningTotal = flatFee
    ? flatTotal === ""
      ? null
      : Number(flatTotal)
    : effectiveItems.reduce(
        (sum, li) => sum + (Number(li.quantity) || 0) * (Number(li.unit_cost) || 0),
        0
      )

  const sourceBid =
    po?.source_bid_recipient_id != null
      ? data.source_bids[po.source_bid_recipient_id]
      : undefined
  const myComments = po
    ? data.comments.filter((c) => c.purchase_order_id === po.id)
    : []

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const newAtts: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${data.project_id}/purchase-orders/${Date.now()}-${Math.random()
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

  function buildPayload(): PurchaseOrderInputT | null {
    if (!title.trim()) {
      toast.error("Title is required")
      return null
    }
    if (!companyId) {
      toast.error("Pick a sub/vendor")
      return null
    }
    if (flatFee && flatTotal === "") {
      toast.error("Enter the flat-fee amount")
      return null
    }
    return {
      id: po?.id,
      project_id: data.project_id,
      title: title.trim(),
      scope: scope || null,
      company_id: companyId,
      custom_number: customNumber || null,
      approval_deadline: approvalDeadline || null,
      flat_fee: flatFee,
      flat_total: flatFee ? Number(flatTotal) : null,
      line_items: flatFee
        ? []
        : effectiveItems.map((li) => ({
            id: li.id,
            cost_code_id: li.cost_code_id || null,
            description: li.description.trim(),
            quantity: li.quantity,
            unit: li.unit || null,
            unit_cost: li.unit_cost,
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

  function handleSave(releaseAfter: boolean) {
    const payload = buildPayload()
    if (!payload) return
    if (
      releaseAfter &&
      !confirm(
        "Release this PO? The sub gets a private approval link by email/SMS."
      )
    )
      return
    startTransition(async () => {
      try {
        const { id } = await savePurchaseOrder(payload)
        if (releaseAfter) {
          await releasePurchaseOrder({ id, project_id: data.project_id })
          toast.success("Released — the sub was sent their approval link")
        } else {
          toast.success(po ? "Saved" : "Draft PO created")
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  function handleUnrelease() {
    if (!po) return
    const warn =
      status === "approved"
        ? "Unrelease this approved PO? The approval is cleared and the sub must re-approve the revised document on the next release."
        : status === "declined"
        ? "Unrelease to revise? The decline is cleared and the old link goes dead."
        : "Unrelease this PO? The public link stops working and any responses are cleared."
    if (!confirm(warn)) return
    startTransition(async () => {
      try {
        await unreleasePurchaseOrder({ id: po.id, project_id: data.project_id })
        toast.success("Back to draft")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unrelease failed")
      }
    })
  }

  function handleApproveOnBehalf() {
    if (!po) return
    if (!signerName.trim()) {
      toast.error("Enter the signer's name")
      return
    }
    startTransition(async () => {
      try {
        await staffApprovePurchaseOrder({
          id: po.id,
          project_id: data.project_id,
          signature_name: signerName,
        })
        toast.success("Approved on the sub's behalf")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Approve failed")
      }
    })
  }

  function handleVoid() {
    if (!po) return
    if (
      !confirm(
        "Void this PO? It's rescinded but kept for the record; the public link stops working."
      )
    )
      return
    startTransition(async () => {
      try {
        await voidPurchaseOrder({ id: po.id, project_id: data.project_id })
        toast.success("Voided")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Void failed")
      }
    })
  }

  function handleWorkComplete(complete: boolean) {
    if (!po) return
    startTransition(async () => {
      try {
        await setPoWorkComplete({
          id: po.id,
          project_id: data.project_id,
          complete,
        })
        toast.success(
          complete ? "Marked work complete" : "Work complete cleared"
        )
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Update failed")
      }
    })
  }

  function handlePushToQbo() {
    if (!po) return
    startTransition(async () => {
      try {
        const res = await pushPurchaseOrderToQbo({
          id: po.id,
          project_id: data.project_id,
        })
        if (res.ok) {
          toast.success(
            res.already_existed
              ? `Already in QuickBooks (PO ${res.doc_number})`
              : `Pushed to QuickBooks (PO ${res.doc_number})`
          )
          router.refresh()
        } else {
          toast.error(res.error)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Push failed")
      }
    })
  }

  function handleDelete() {
    if (!po) return
    if (!confirm("Delete this draft PO and its attachments?")) return
    startTransition(async () => {
      try {
        await deletePurchaseOrder({ id: po.id, project_id: data.project_id })
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  function copyPublicLink() {
    if (!po?.token) {
      toast.error("No active link — release the PO first")
      return
    }
    navigator.clipboard
      .writeText(`${window.location.origin}/po/${po.token}`)
      .then(() => toast.success("Public approval link copied"))
      .catch(() => toast.error("Could not copy — check clipboard permissions"))
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {po && (
                <span className="text-xs font-mono text-muted">
                  PO-{po.number}
                  {po.custom_number ? ` · ${po.custom_number}` : ""}
                </span>
              )}
              <PoStatusBadge status={status} />
              {po?.work_complete && (
                <Badge tone="success">
                  <CheckCircle2 className="h-3 w-3" /> Work complete
                </Badge>
              )}
              {sourceBid && (
                <Link
                  href={`/projects/${data.project_id}/bids`}
                  className="inline-flex"
                >
                  <Badge tone="brand" className="hover:opacity-80">
                    <Gavel className="h-3 w-3" /> From BID-{sourceBid.number}:{" "}
                    {sourceBid.title}
                  </Badge>
                </Link>
              )}
            </div>
            <DialogTitle>{po ? po.title : "New purchase order"}</DialogTitle>
            <DialogDescription>
              The sub approves with a typed signature through a private link.
              Approved POs roll into committed costs.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {/* Status banners */}
          {status === "approved" && po && (
            <div className="rounded-md border border-green-200 bg-green-50/60 p-3 text-sm">
              <span className="font-medium text-green-800">
                Approved
                {po.approved_signature ? ` — signed "${po.approved_signature}"` : ""}
              </span>
              <span className="text-green-800/80">
                {po.approved_at ? ` on ${formatDate(po.approved_at)}` : ""}
                {po.approved_by_profile_id ? " (entered by team)" : ""}
              </span>
            </div>
          )}
          {status === "declined" && po && (
            <div className="rounded-md border border-red-200 bg-red-50/60 p-3 text-sm">
              <span className="font-medium text-red-800">
                Declined{po.declined_at ? ` on ${formatDate(po.declined_at)}` : ""}
              </span>
              {po.decline_reason && (
                <p className="text-red-800/90 mt-1 whitespace-pre-wrap">
                  {po.decline_reason}
                </p>
              )}
            </div>
          )}
          {!isDraft && status !== "void" && (
            <p className="text-xs text-muted inline-flex items-center gap-1">
              <Lock className="h-3 w-3" />
              Editing is disabled after release — unrelease to edit.
            </p>
          )}

          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!isDraft}
              placeholder="Plumbing rough-in"
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Sub / vendor">
              <Select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                disabled={!isDraft}
              >
                <option value="">— Select —</option>
                {data.companies.map((c) => (
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
                disabled={!isDraft}
                placeholder="2024-118"
              />
            </Field>
          </div>
          <Field label="Scope">
            <Textarea
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              disabled={!isDraft}
              rows={4}
              placeholder="Work covered by this PO, exclusions, terms."
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Approval deadline"
              hint="The sub is asked to approve by this date."
            >
              <Input
                type="date"
                value={approvalDeadline}
                onChange={(e) => setApprovalDeadline(e.target.value)}
                disabled={!isDraft}
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
                  One total, no line items.
                </span>
              </span>
            </label>
            {flatFee && (
              <Field label="Flat total">
                <Input
                  type="number"
                  step="0.01"
                  value={flatTotal}
                  onChange={(e) => setFlatTotal(e.target.value)}
                  disabled={!isDraft}
                  placeholder="0.00"
                  className="w-40 text-right tabular-nums"
                />
              </Field>
            )}
          </div>

          {!flatFee && (
            <PoLineItemsEditor
              items={lineItems}
              onChange={setLineItems}
              costCodes={data.cost_codes}
              frozen={!isDraft}
              total={runningTotal ?? 0}
            />
          )}

          {/* Attachments */}
          <div>
            <Label>Files</Label>
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
                  {isDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        // Unsaved uploads have no DB row yet — best-effort
                        // delete the orphaned storage object. Saved ones are
                        // cleaned up by the server action on save.
                        if (!a.id) {
                          createSupabaseBrowserClient()
                            .storage.from("project-files")
                            .remove([a.storage_path])
                            .catch(() => {})
                        }
                        setAttachments((current) =>
                          current.filter(
                            (x) => x.storage_path !== a.storage_path
                          )
                        )
                      }}
                      className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-1.5 sm:p-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 cursor-pointer"
                      aria-label="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {isDraft && (
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

          {/* Comments */}
          <PoCommentsThread
            poId={po?.id}
            projectId={data.project_id}
            comments={myComments}
          />
        </DialogBody>
        {copyOpen && po ? (
          <CopyPoFooter
            projects={data.projects}
            currentProjectId={data.project_id}
            pending={pending}
            onCancel={() => setCopyOpen(false)}
            onCopy={handleCopy}
          />
        ) : approveOpen && po ? (
          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <div className="flex-1 min-w-0">
              <Label className="mb-1">
                Approve on the sub&apos;s behalf — signer&apos;s name
              </Label>
              <Input
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Who approved it (e.g. over the phone)?"
              />
            </div>
            <div className="flex items-center gap-2 sm:self-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setApproveOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleApproveOnBehalf}
                disabled={pending || !signerName.trim()}
              >
                <PenLine className="h-4 w-4" />
                {pending ? "Approving…" : "Approve"}
              </Button>
            </div>
          </DialogFooter>
        ) : (
          <DialogFooter className="flex-wrap">
            {po && (
              <div className="mr-auto flex items-center gap-1">
                {isDraft && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleDelete}
                    disabled={pending}
                    className="text-danger hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCopyOpen(true)}
                  disabled={pending}
                >
                  <Copy className="h-4 w-4" /> Copy to job…
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {isDraft && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => handleSave(false)}
                  disabled={pending || uploading}
                >
                  {pending ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  onClick={() => handleSave(true)}
                  disabled={pending || uploading}
                >
                  <Send className="h-4 w-4" /> Release to sub
                </Button>
              </>
            )}
            {status === "released" && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleVoid}
                  disabled={pending}
                >
                  <Ban className="h-4 w-4" /> Void
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleUnrelease}
                  disabled={pending}
                >
                  <Undo2 className="h-4 w-4" /> Unrelease
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={copyPublicLink}
                >
                  <Link2 className="h-4 w-4" /> Copy public link
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setSignerName("")
                    setApproveOpen(true)
                  }}
                  disabled={pending}
                >
                  <PenLine className="h-4 w-4" /> Approve on behalf
                </Button>
              </>
            )}
            {status === "approved" && po && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleVoid}
                  disabled={pending}
                >
                  <Ban className="h-4 w-4" /> Void
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleUnrelease}
                  disabled={pending}
                >
                  <Undo2 className="h-4 w-4" /> Unrelease
                </Button>
                <Button
                  type="button"
                  variant={po.work_complete ? "secondary" : "primary"}
                  onClick={() => handleWorkComplete(!po.work_complete)}
                  disabled={pending}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {po.work_complete
                    ? "Un-mark work complete"
                    : "Mark work complete"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handlePushToQbo}
                  disabled={pending}
                >
                  <Upload className="h-4 w-4" /> Push to QuickBooks
                </Button>
              </>
            )}
            {status === "declined" && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleVoid}
                  disabled={pending}
                >
                  <Ban className="h-4 w-4" /> Void
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleUnrelease}
                  disabled={pending}
                >
                  <Undo2 className="h-4 w-4" /> Unrelease to revise
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Inline footer for copying this PO to another job — mirrors CopyDecisionFooter.
function CopyPoFooter({
  projects,
  currentProjectId,
  pending,
  onCancel,
  onCopy,
}: {
  projects: PurchaseOrdersData["projects"]
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
        <Label className="mb-1">Copy this PO to…</Label>
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

/** Line-item editor with unit costs and a running total. */
function PoLineItemsEditor({
  items,
  onChange,
  costCodes,
  frozen,
  total,
}: {
  items: LineItem[]
  onChange: (v: LineItem[]) => void
  costCodes: PurchaseOrdersData["cost_codes"]
  frozen: boolean
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
  function update(i: number, patch: Partial<LineItem>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }
  return (
    <div className="rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
      <Label>Line items</Label>
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="text-left font-medium pb-1.5 w-[26%]">
                  Cost code
                </th>
                <th className="text-left font-medium pb-1.5">Description</th>
                <th className="text-right font-medium pb-1.5 w-20">Qty</th>
                <th className="text-left font-medium pb-1.5 w-16">Unit</th>
                <th className="text-right font-medium pb-1.5 w-28">
                  Unit cost
                </th>
                <th className="text-right font-medium pb-1.5 w-28">
                  Line total
                </th>
                {!frozen && <th className="w-6"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((li, i) => {
                const lineTotal = (li.quantity || 0) * (li.unit_cost || 0)
                return (
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
                        {/* The page only fetches active codes — keep a stale
                            selection representable so the controlled Select
                            doesn't silently drop it on save. */}
                        {li.cost_code_id &&
                          !costCodes.some((c) => c.id === li.cost_code_id) && (
                            <option value={li.cost_code_id}>
                              (inactive code)
                            </option>
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
                    <td className="pr-1.5 pb-1.5">
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right tabular-nums"
                        value={li.unit_cost}
                        disabled={frozen}
                        onChange={(e) =>
                          update(i, { unit_cost: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="pr-1.5 pb-1.5 text-right font-mono tabular-nums pt-2">
                      {formatCurrency(lineTotal)}
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
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {!frozen ? (
          <button
            type="button"
            onClick={add}
            className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
          >
            <Plus className="h-3 w-3" /> Add line
          </button>
        ) : (
          <span />
        )}
        <span className="text-sm font-semibold font-mono tabular-nums">
          Total {formatCurrency(total)}
        </span>
      </div>
    </div>
  )
}

function PoCommentsThread({
  poId,
  projectId,
  comments,
}: {
  poId?: string
  projectId: string
  comments: Tables<"po_comments">[]
}) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!poId || !body.trim()) return
    startTransition(async () => {
      try {
        await postPoCommentStaff({
          purchase_order_id: poId,
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
        {comments.map((c) => (
          <li
            key={c.id}
            className="rounded-md border border-border p-2 bg-background/30"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">{c.author_name}</span>
              {!c.author_profile_id && <Badge tone="info">sub</Badge>}
              <span className="text-xs text-muted">
                {formatDate(c.created_at)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap mt-0.5">{c.body}</p>
          </li>
        ))}
      </ul>
      {poId ? (
        <div className="mt-3 flex gap-2 items-end">
          <div className="flex-1">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder="Message the sub — they get an email with their link"
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
      ) : (
        <p className="mt-2 text-xs text-muted">
          Comments are available after saving the PO.
        </p>
      )}
    </div>
  )
}
