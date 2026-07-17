"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  approvePoByToken,
  declinePoByToken,
  postPoCommentPublic,
} from "@/app/actions/po-public"
import { Button } from "@/components/ui/button"
import { Input, Textarea, Field } from "@/components/ui/input"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDate, cn } from "@/lib/utils"
import { actionErrorMessage } from "@/lib/action-error"

type Comment = {
  id: string
  author_name: string
  fromBuilder: boolean
  body: string
  created_at: string
}

export function PoApprovalForm({
  token,
  active,
  comments,
}: {
  token: string
  active: boolean
  comments: Comment[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [signature, setSignature] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const run = (fn: () => Promise<unknown>) => {
    setError(null)
    startTransition(async () => {
      try {
        await fn()
        router.refresh()
      } catch (e) {
        setError(
          actionErrorMessage(e, "Something went wrong — please try again.")
        )
      }
    })
  }

  const handleApprove = () => {
    if (signature.trim().length < 2) {
      setError("Type your full name as your signature.")
      return
    }
    if (!accepted) {
      setError("Check the box to confirm you agree.")
      return
    }
    if (!window.confirm("Approve this purchase order? Your typed name will be recorded as your signature.")) {
      return
    }
    run(() =>
      approvePoByToken({
        token,
        signature_name: signature.trim(),
        disclaimer_accepted: accepted,
      })
    )
  }

  const handleDecline = () => {
    if (declineReason.trim().length < 2) {
      setError("Tell us why you're declining.")
      return
    }
    if (!window.confirm("Decline this purchase order?")) return
    run(() => declinePoByToken({ token, reason: declineReason.trim() }))
  }

  return (
    <div className="flex flex-col gap-4">
      {active && (
        <Card>
          <CardHeader>
            <CardTitle>Approve this purchase order</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <Field
              label="Type your full name as signature"
              htmlFor="po-signature"
            >
              <Input
                id="po-signature"
                autoComplete="name"
                placeholder="Full name"
                className="h-11 text-base"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
              />
            </Field>

            <label className="flex items-start gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-brand-500"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                I have reviewed this purchase order and agree to perform the
                work described for the stated amount.
              </span>
            </label>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                className="w-full"
                disabled={isPending}
                onClick={handleApprove}
              >
                {isPending ? "Working…" : "Approve purchase order"}
              </Button>
              {!declineOpen ? (
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full text-muted"
                  disabled={isPending}
                  onClick={() => setDeclineOpen(true)}
                >
                  Decline
                </Button>
              ) : (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <Field label="Reason for declining (required)" htmlFor="po-decline-reason">
                    <Textarea
                      id="po-decline-reason"
                      placeholder="Pricing, scope, timing…"
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
          </CardBody>
        </Card>
      )}

      {!active && error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <CommentThread token={token} comments={comments} />
    </div>
  )
}

function CommentThread({ token, comments }: { token: string; comments: Comment[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)

  const handleSend = () => {
    if (!body.trim()) return
    setError(null)
    startTransition(async () => {
      try {
        await postPoCommentPublic({ token, body })
        setBody("")
        router.refresh()
      } catch (e) {
        setError(
          actionErrorMessage(e, "Something went wrong — please try again.")
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
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Message"
            placeholder="Ask a question about this purchase order…"
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
      </CardBody>
    </Card>
  )
}
