"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  saveBidDraft,
  submitBidResponse,
  declineBid,
  postBidCommentPublic,
} from "@/app/actions/bid-public"
import { Button } from "@/components/ui/button"
import { Input, Textarea, Field } from "@/components/ui/input"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency, formatDate, cn } from "@/lib/utils"

type LineItem = {
  id: string
  description: string
  codeLabel: string | null
  quantity: number
  unit: string | null
}

type Comment = {
  id: string
  author_name: string
  fromBuilder: boolean
  body: string
  created_at: string
}

export function BidResponseForm({
  token,
  flatFee,
  lineItems,
  initialQuotes,
  initialFlatTotal,
  initialNotes,
  status,
  packageClosed,
  comments,
}: {
  token: string
  flatFee: boolean
  lineItems: LineItem[]
  initialQuotes: Record<string, string>
  initialFlatTotal: number | null
  initialNotes: string
  status: "invited" | "submitted" | "declined" | "awarded"
  packageClosed: boolean
  comments: Comment[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [quotes, setQuotes] = useState<Record<string, string>>(initialQuotes)
  const [flatTotal, setFlatTotal] = useState(
    initialFlatTotal != null ? String(initialFlatTotal) : ""
  )
  const [notes, setNotes] = useState(initialNotes)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState("")

  const editable = status === "invited" && !packageClosed
  const showPricing = status === "submitted" || status === "awarded" || editable
  const commentsEnabled = !packageClosed

  const lineTotal = (li: LineItem) => {
    const cost = parseFloat(quotes[li.id] ?? "")
    return Number.isFinite(cost) ? cost * li.quantity : null
  }
  const grandTotal = flatFee
    ? parseFloat(flatTotal)
    : lineItems.reduce((sum, li) => sum + (lineTotal(li) ?? 0), 0)

  const quotesPayload = () =>
    lineItems
      .filter((li) => (quotes[li.id] ?? "") !== "")
      .map((li) => ({ line_item_id: li.id, unit_cost: Number(quotes[li.id]) }))

  const run = (fn: () => Promise<unknown>, successMsg: string | null) => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      try {
        await fn()
        if (successMsg) setNotice(successMsg)
        router.refresh()
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Something went wrong — please try again."
        )
      }
    })
  }

  const handleSave = () =>
    run(
      () =>
        saveBidDraft({
          token,
          quotes: quotesPayload(),
          flat_total: flatFee && flatTotal !== "" ? Number(flatTotal) : null,
          notes,
        }),
      "Draft saved — you can come back to this link any time."
    )

  const handleSubmit = () => {
    if (flatFee) {
      if (flatTotal === "" || !Number.isFinite(Number(flatTotal))) {
        setError("Enter your total price before submitting.")
        return
      }
    } else {
      const missing = lineItems.some((li) => (quotes[li.id] ?? "") === "")
      if (missing) {
        setError("Enter a price for every line item before submitting.")
        return
      }
    }
    if (!window.confirm("Submit this bid? You won't be able to edit it afterward.")) {
      return
    }
    run(
      () =>
        submitBidResponse({
          token,
          quotes: quotesPayload(),
          flat_total: flatFee && flatTotal !== "" ? Number(flatTotal) : null,
          notes,
        }),
      null
    )
  }

  const handleDecline = () => {
    if (!window.confirm("Decline this bid? This can't be undone.")) return
    run(() => declineBid({ token, reason: declineReason || null }), null)
  }

  return (
    <div className="flex flex-col gap-4">
      {showPricing && (
        <Card>
          <CardHeader>
            <CardTitle>{editable ? "Your pricing" : "Your submitted pricing"}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {flatFee ? (
              editable ? (
                <Field label="Total price" htmlFor="bid-flat-total">
                  <Input
                    id="bid-flat-total"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    className="h-11 text-base max-w-xs"
                    value={flatTotal}
                    onChange={(e) => setFlatTotal(e.target.value)}
                  />
                </Field>
              ) : (
                <p className="text-sm">
                  Total:{" "}
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(initialFlatTotal)}
                  </span>
                </p>
              )
            ) : (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted uppercase tracking-wide border-b border-border">
                      <th className="py-2 pr-3 font-medium">Item</th>
                      <th className="py-2 pr-3 font-medium text-right">Qty</th>
                      <th className="py-2 pr-3 font-medium text-right">Unit cost</th>
                      <th className="py-2 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-border last:border-0">
                        <td className="py-2 pr-3 align-top">
                          <div>{li.description}</div>
                          {li.codeLabel && (
                            <div className="text-xs text-muted">{li.codeLabel}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right align-top tabular-nums whitespace-nowrap">
                          {li.quantity}
                          {li.unit ? ` ${li.unit}` : ""}
                        </td>
                        <td className="py-2 pr-3 text-right align-top">
                          {editable ? (
                            <Input
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              aria-label={`Unit cost for ${li.description}`}
                              className="h-11 w-28 ml-auto text-right text-base"
                              value={quotes[li.id] ?? ""}
                              onChange={(e) =>
                                setQuotes((q) => ({ ...q, [li.id]: e.target.value }))
                              }
                            />
                          ) : (
                            <span className="tabular-nums">
                              {quotes[li.id] !== undefined && quotes[li.id] !== ""
                                ? formatCurrency(Number(quotes[li.id]))
                                : "—"}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right align-top tabular-nums">
                          {lineTotal(li) != null ? formatCurrency(lineTotal(li)) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="py-2 pr-3 text-right font-medium">
                        Grand total
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums">
                        {formatCurrency(
                          editable
                            ? Number.isFinite(grandTotal)
                              ? grandTotal
                              : 0
                            : initialFlatTotal
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {editable ? (
              <Field label="Notes (optional)" htmlFor="bid-notes">
                <Textarea
                  id="bid-notes"
                  placeholder="Exclusions, lead times, questions…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            ) : (
              initialNotes && (
                <div>
                  <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    Your notes
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{initialNotes}</p>
                </div>
              )
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {notice && <p className="text-sm text-green-700">{notice}</p>}

            {editable && (
              <div className="flex flex-col gap-2">
                <Button
                  size="lg"
                  className="w-full"
                  disabled={isPending}
                  onClick={handleSubmit}
                >
                  {isPending ? "Working…" : "Submit bid"}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  disabled={isPending}
                  onClick={handleSave}
                >
                  Save for later
                </Button>
                {!declineOpen ? (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="w-full text-muted"
                    disabled={isPending}
                    onClick={() => setDeclineOpen(true)}
                  >
                    Decline to bid
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <Field label="Reason (optional)" htmlFor="bid-decline-reason">
                      <Textarea
                        id="bid-decline-reason"
                        placeholder="Booked up, out of our scope…"
                        value={declineReason}
                        onChange={(e) => setDeclineReason(e.target.value)}
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        className="flex-1"
                        disabled={isPending}
                        onClick={handleDecline}
                      >
                        Confirm decline
                      </Button>
                      <Button
                        variant="secondary"
                        className="flex-1"
                        disabled={isPending}
                        onClick={() => setDeclineOpen(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {(!showPricing && error) ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <CommentThread
        token={token}
        comments={comments}
        enabled={commentsEnabled}
      />
    </div>
  )
}

function CommentThread({
  token,
  comments,
  enabled,
}: {
  token: string
  comments: Comment[]
  enabled: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)

  const handleSend = () => {
    if (!body.trim()) return
    setError(null)
    startTransition(async () => {
      try {
        await postBidCommentPublic({ token, body })
        setBody("")
        router.refresh()
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Something went wrong — please try again."
        )
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messages</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {comments.length === 0 ? (
          <p className="text-sm text-muted">
            No messages yet. Ask a question below and we&apos;ll reply by email.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {comments.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "rounded-md border border-border p-3",
                  c.fromBuilder ? "bg-brand-100/40" : "bg-background"
                )}
              >
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-xs font-medium">{c.author_name}</span>
                  <span className="text-xs text-muted whitespace-nowrap">
                    {formatDate(c.created_at)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        {enabled ? (
          <div className="flex flex-col gap-2">
            <Textarea
              placeholder="Ask a question about this bid…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button
              className="self-end"
              disabled={isPending || !body.trim()}
              onClick={handleSend}
            >
              {isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">
            This thread is closed to new messages.
          </p>
        )}
      </CardBody>
    </Card>
  )
}
