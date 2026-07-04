"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Trophy, MessageSquare, ChevronDown, ChevronRight, Eye } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Textarea, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn, formatCurrency, formatDate } from "@/lib/utils"
import { awardBid, postBidCommentStaff } from "@/app/actions/bids"
import {
  BidStatusBadge,
  RecipientStatusBadge,
  recipientBidTotal,
} from "@/app/(app)/projects/[id]/bids/bids-client"
import type { Tables } from "@/lib/db/types"
import type { BidsData } from "@/app/(app)/projects/[id]/bids/bids-client"

export function BidComparison({
  open,
  onClose,
  pkg,
  data,
  initialAwardRecipientId,
}: {
  open: boolean
  onClose: () => void
  pkg: Tables<"bid_packages">
  data: BidsData
  // Deep-link straight into the award confirm for one bid (e.g. the
  // "Award & create PO" shortcut on a recipient row in the package drawer).
  initialAwardRecipientId?: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Recipient being awarded — opens the inline confirm panel in the footer
  // (inline rather than a nested Dialog so two focus-traps don't fight).
  const [awarding, setAwarding] = useState<string | null>(
    initialAwardRecipientId ?? null
  )
  const [createPo, setCreatePo] = useState(true)
  const [notifyLosers, setNotifyLosers] = useState(false)

  const recipients = data.recipients.filter(
    (r) => r.bid_package_id === pkg.id
  )
  const lineItems = data.line_items.filter(
    (li) => li.bid_package_id === pkg.id
  )
  const quoteFor = (recipientId: string, lineItemId: string) =>
    data.quotes.find(
      (q) => q.bid_recipient_id === recipientId && q.line_item_id === lineItemId
    )

  const totals = new Map<string, number | null>(
    recipients.map((r) => [r.id, recipientBidTotal(r, pkg, data)])
  )
  const submittedTotals = recipients
    .filter((r) => r.status === "submitted" || r.status === "awarded")
    .map((r) => totals.get(r.id))
    .filter((t): t is number => t != null)
  const lowest = submittedTotals.length ? Math.min(...submittedTotals) : null

  const canAward = (r: BidsData["recipients"][number]) =>
    r.status === "submitted" &&
    (pkg.status === "sent" ||
      (pkg.status === "awarded" && pkg.allow_multiple_awards))

  const awardingRecipient = awarding
    ? recipients.find((r) => r.id === awarding)
    : undefined

  function handleAward() {
    if (!awardingRecipient) return
    startTransition(async () => {
      try {
        const { po_id, po_number } = await awardBid({
          recipient_id: awardingRecipient.id,
          project_id: data.project_id,
          create_po: createPo,
          notify_losers: notifyLosers,
        })
        if (po_id) {
          toast.success(
            `Awarded to ${awardingRecipient.company_name} — draft PO-${po_number} created`
          )
          router.push(
            `/projects/${data.project_id}/purchase-orders?open=${po_id}`
          )
          setAwarding(null)
          onClose()
        } else {
          toast.success(`Awarded to ${awardingRecipient.company_name}`)
          router.refresh()
          setAwarding(null)
          // Multi-award packages stay open so staff can award more
          // recipients without reopening the comparison.
          if (!pkg.allow_multiple_awards) onClose()
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Award failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-muted">
                BID-{pkg.number}
              </span>
              <BidStatusBadge status={pkg.status} />
              {pkg.due_date && (
                <span className="text-xs text-muted">
                  Due {formatDate(pkg.due_date)}
                </span>
              )}
            </div>
            <DialogTitle>Compare bids — {pkg.title}</DialogTitle>
            <DialogDescription>
              {pkg.flat_fee
                ? "Flat-fee package — each sub submitted one total."
                : "Unit costs per line item, side by side. Lowest total is highlighted."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {recipients.length === 0 ? (
            <p className="text-sm text-muted">
              No recipients yet — send the package to some subs first.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-background/60">
                  <tr>
                    <th className="text-left font-medium px-3 py-2.5 text-xs uppercase text-muted min-w-[180px]">
                      {pkg.flat_fee ? "" : "Line item"}
                    </th>
                    {recipients.map((r) => (
                      <th
                        key={r.id}
                        className="text-right font-medium px-3 py-2.5 min-w-[140px] align-top"
                      >
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-sm">{r.company_name}</span>
                          <RecipientStatusBadge status={r.status} />
                          {r.submitted_at && (
                            <span className="text-[11px] text-muted font-normal">
                              Submitted {formatDate(r.submitted_at)}
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pkg.flat_fee ? (
                    <tr>
                      <td className="px-3 py-2.5 font-medium">Total</td>
                      {recipients.map((r) => (
                        <td
                          key={r.id}
                          className="px-3 py-2.5 text-right font-mono tabular-nums"
                        >
                          {r.flat_total != null
                            ? formatCurrency(Number(r.flat_total))
                            : "—"}
                        </td>
                      ))}
                    </tr>
                  ) : (
                    lineItems.map((li) => {
                      const costCode = data.cost_codes.find(
                        (c) => c.id === li.cost_code_id
                      )
                      return (
                        <tr key={li.id}>
                          <td className="px-3 py-2.5">
                            <div className="font-medium">{li.description}</div>
                            <div className="text-[11px] text-muted">
                              {costCode ? `${costCode.name} · ` : ""}
                              {Number(li.quantity)} {li.unit ?? ""}
                            </div>
                          </td>
                          {recipients.map((r) => {
                            const q = quoteFor(r.id, li.id)
                            const hasQuote =
                              q != null &&
                              (r.status === "submitted" ||
                                r.status === "awarded")
                            return (
                              <td
                                key={r.id}
                                className="px-3 py-2.5 text-right font-mono tabular-nums"
                              >
                                {hasQuote ? (
                                  formatCurrency(
                                    Number(q.unit_cost) * Number(li.quantity)
                                  )
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-background/40">
                    <td className="px-3 py-2.5 font-semibold">Total</td>
                    {recipients.map((r) => {
                      const total = totals.get(r.id) ?? null
                      const responded =
                        r.status === "submitted" || r.status === "awarded"
                      const isLowest =
                        responded && total != null && total === lowest
                      return (
                        <td
                          key={r.id}
                          className={cn(
                            "px-3 py-2.5 text-right font-mono tabular-nums font-semibold",
                            isLowest && "bg-green-100 text-green-800"
                          )}
                        >
                          {responded && total != null
                            ? formatCurrency(total)
                            : "—"}
                        </td>
                      )
                    })}
                  </tr>
                  <tr>
                    <td className="px-3 py-2"></td>
                    {recipients.map((r) => (
                      <td key={r.id} className="px-3 py-2 text-right">
                        {canAward(r) && (
                          <Button
                            size="sm"
                            variant={
                              totals.get(r.id) === lowest
                                ? "primary"
                                : "secondary"
                            }
                            disabled={pending}
                            onClick={() => setAwarding(r.id)}
                          >
                            <Trophy className="h-3.5 w-3.5" /> Award &amp; create PO
                          </Button>
                        )}
                        {r.status === "awarded" && (
                          <Badge tone="success">
                            <Trophy className="h-3 w-3" /> Awarded
                          </Badge>
                        )}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Per-recipient detail: viewed/notes metadata + comment thread. */}
          {recipients.length > 0 && (
            <div className="space-y-2">
              <Label>
                <MessageSquare className="inline h-3 w-3 mr-1" />
                Messages &amp; notes
              </Label>
              {recipients.map((r) => (
                <RecipientThread
                  key={r.id}
                  recipient={r}
                  comments={data.comments.filter(
                    (c) => c.bid_recipient_id === r.id
                  )}
                  projectId={data.project_id}
                />
              ))}
            </div>
          )}
        </DialogBody>
        {awardingRecipient ? (
          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="text-sm font-medium">
                Award &quot;{pkg.title}&quot; to {awardingRecipient.company_name}
                {totals.get(awardingRecipient.id) != null &&
                  ` for ${formatCurrency(totals.get(awardingRecipient.id)!)}`}
                ?
              </p>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={createPo}
                  onChange={(e) => setCreatePo(e.target.checked)}
                  className="accent-brand-500"
                />
                Create draft PO from this bid
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyLosers}
                  onChange={(e) => setNotifyLosers(e.target.checked)}
                  className="accent-brand-500"
                />
                Notify other bidders
              </label>
            </div>
            <div className="flex items-center gap-2 sm:self-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAwarding(null)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleAward} disabled={pending}>
                <Trophy className="h-4 w-4" />
                {pending ? "Awarding…" : "Award bid"}
              </Button>
            </div>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Expandable per-recipient thread: submission notes, viewed_at metadata, and
 * the staff ↔ sub comment history with a reply box.
 */
function RecipientThread({
  recipient,
  comments,
  projectId,
}: {
  recipient: BidsData["recipients"][number]
  comments: Tables<"bid_comments">[]
  projectId: string
}) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!body.trim()) return
    startTransition(async () => {
      try {
        await postBidCommentStaff({
          bid_recipient_id: recipient.id,
          project_id: projectId,
          body,
        })
        setBody("")
        toast.success("Posted — the sub was emailed their link")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not post")
      }
    })
  }

  return (
    <div className="rounded-md border border-border bg-background/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-background/60"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted" />
        )}
        <span className="font-medium">{recipient.company_name}</span>
        <RecipientStatusBadge status={recipient.status} />
        {recipient.viewed_at && (
          <span className="text-[11px] text-muted inline-flex items-center gap-1">
            <Eye className="h-3 w-3" /> Viewed {formatDate(recipient.viewed_at)}
          </span>
        )}
        <span className="ml-auto text-xs text-muted">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
          {recipient.notes && (
            <div className="rounded-md border border-border bg-surface p-2 text-sm">
              <span className="text-[11px] uppercase tracking-wide text-muted block mb-0.5">
                Their notes
              </span>
              <p className="whitespace-pre-wrap">{recipient.notes}</p>
            </div>
          )}
          <ul className="space-y-2">
            {comments.length === 0 && (
              <li className="text-xs text-muted">No messages yet.</li>
            )}
            {comments.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-border p-2 bg-surface"
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
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={2}
                placeholder={`Message ${recipient.company_name}…`}
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
        </div>
      )}
    </div>
  )
}
