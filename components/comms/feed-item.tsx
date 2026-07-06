"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  MessageSquare,
  Mail,
  MessageCircle,
  Phone,
  ArrowUpRight,
  ArrowDownLeft,
  CornerDownRight,
} from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import type { FeedItem } from "@/lib/comms/feed"
import { postComment } from "@/app/actions/decisions"
import { postBidCommentStaff } from "@/app/actions/bids"
import { postPoCommentStaff } from "@/app/actions/purchase-orders"
import { postScheduleItemComment } from "@/app/actions/schedule"
import { postDailyLogComment } from "@/app/actions/daily-logs"
import { sendSmsReply } from "@/app/actions/communications"

const KIND_META = {
  comment: { icon: MessageSquare, label: "Comment", className: "text-brand-600 bg-brand-50" },
  email: { icon: Mail, label: "Email", className: "text-sky-700 bg-sky-50" },
  sms: { icon: MessageCircle, label: "Text", className: "text-emerald-700 bg-emerald-50" },
  call: { icon: Phone, label: "Call", className: "text-purple-700 bg-purple-50" },
} as const

const ROLE_CHIP: Record<string, { label: string; className: string } | undefined> = {
  client: { label: "client", className: "text-blue-700 bg-blue-100" },
  trade: { label: "sub", className: "text-amber-700 bg-amber-100" },
  external: undefined,
  staff: undefined,
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * One row of the Communications feed. `canReply` (staff) enables the inline
 * comment reply, which posts straight into the source entity's thread via
 * that entity's existing server action.
 */
export function FeedItemRow({
  item,
  projectId,
  canReply,
}: {
  item: FeedItem
  projectId: string
  canReply: boolean
}) {
  const router = useRouter()
  const [replying, setReplying] = useState(false)
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  const meta = KIND_META[item.kind]
  const Icon = meta.icon
  const chip = ROLE_CHIP[item.author.role]

  function submitReply() {
    const reply = item.reply
    if (!reply || !body.trim()) return
    startTransition(async () => {
      try {
        const text = body.trim()
        if (reply.type === "sms") {
          const result = await sendSmsReply({
            communication_id: reply.communicationId,
            body: text,
          })
          if (!result.ok) throw new Error(result.error ?? "Failed to send text")
          toast.success("Text sent")
          setBody("")
          setReplying(false)
          router.refresh()
          return
        }
        switch (reply.entityType) {
          case "decision":
            await postComment({
              decision_id: reply.entityId,
              project_id: projectId,
              body: text,
            })
            break
          case "bid":
            if (!reply.recipientId) throw new Error("Missing bid recipient")
            await postBidCommentStaff({
              bid_recipient_id: reply.recipientId,
              project_id: projectId,
              body: text,
            })
            break
          case "po":
            await postPoCommentStaff({
              purchase_order_id: reply.entityId,
              project_id: projectId,
              body: text,
            })
            break
          case "schedule_item":
            await postScheduleItemComment({
              schedule_item_id: reply.entityId,
              project_id: projectId,
              body: text,
            })
            break
          case "daily_log":
            await postDailyLogComment({
              daily_log_id: reply.entityId,
              project_id: projectId,
              body: text,
            })
            break
        }
        setBody("")
        setReplying(false)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not post reply")
      }
    })
  }

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
      <span
        className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.className}`}
        title={meta.label}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <Avatar name={item.author.name} size="xs" />
          <span className="text-sm font-medium">{item.author.name}</span>
          {chip && (
            <span className={`text-[10px] px-1 py-0.5 rounded ${chip.className}`}>
              {chip.label}
            </span>
          )}
          {item.direction && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted uppercase tracking-wide">
              {item.direction === "outbound" ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownLeft className="h-3 w-3" />
              )}
              {item.direction}
            </span>
          )}
          <span className="text-xs text-muted ml-auto whitespace-nowrap">
            {formatTime(item.occurredAt)}
          </span>
        </div>

        {item.entity && (
          <Link
            href={item.entity.href}
            className="mt-0.5 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
          >
            on {item.entity.label}
          </Link>
        )}

        {item.subject && (
          <div className="mt-1 text-sm font-medium">{item.subject}</div>
        )}
        {item.body && (
          <p className="mt-0.5 text-sm whitespace-pre-wrap break-words line-clamp-6">
            {item.body}
          </p>
        )}
        {item.kind === "call" && (
          <div className="mt-1 flex items-center gap-3 text-xs text-muted">
            {item.callDurationSeconds != null && (
              <span>Duration: {formatDuration(item.callDurationSeconds)}</span>
            )}
            {item.callRecordingUrl && (
              <a
                href={item.callRecordingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 hover:underline"
              >
                Recording
              </a>
            )}
          </div>
        )}

        {canReply && item.reply && (
          <div className="mt-1.5">
            {!replying ? (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline cursor-pointer"
              >
                <CornerDownRight className="h-3 w-3" />
                {item.reply.type === "sms" ? "Reply by text" : "Reply"}
              </button>
            ) : (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={2}
                    placeholder={
                      item.reply.type === "sms"
                        ? "Text back — sends an SMS from the business number"
                        : "Reply — posts to the item's thread"
                    }
                    autoFocus
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={submitReply}
                  disabled={pending || !body.trim()}
                >
                  Post
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReplying(false)
                    setBody("")
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
