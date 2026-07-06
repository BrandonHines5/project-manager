"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Label, Textarea } from "@/components/ui/input"
import { formatDate } from "@/lib/utils"

export type ThreadComment = {
  id: string
  author_name: string
  /** Renders a small role chip next to non-staff authors. */
  author_role?: "staff" | "client" | "trade" | null
  body: string
  created_at: string
}

/**
 * Generic comment thread for entity drawers (schedule items, daily logs, …).
 * Works off denormalized author names — no profiles lookup needed, which is
 * what lets trades/clients render each other's staff counterparts. The
 * decisions/bids/PO drawers keep their own thread UIs (same look) for now.
 */
export function CommentsThread({
  comments,
  meName,
  canPost,
  placeholder = "Write a comment…",
  unsavedNote,
  hideHeader = false,
  onPost,
}: {
  comments: ThreadComment[]
  meName: string
  canPost: boolean
  placeholder?: string
  /** Shown instead of the composer when the entity hasn't been saved yet. */
  unsavedNote?: string | null
  /** Skip the "Comments" label when the host UI already provides one. */
  hideHeader?: boolean
  onPost: (body: string) => Promise<void>
}) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!body.trim()) return
    startTransition(async () => {
      try {
        await onPost(body.trim())
        setBody("")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not post")
      }
    })
  }

  const roleChip: Record<string, { label: string; className: string }> = {
    client: { label: "client", className: "text-blue-700 bg-blue-100" },
    trade: { label: "sub", className: "text-amber-700 bg-amber-100" },
  }

  return (
    <div>
      {!hideHeader && (
        <Label>
          <MessageSquare className="inline h-3 w-3 mr-1" />
          Comments
        </Label>
      )}
      <ul className="mt-2 space-y-2">
        {comments.length === 0 && !unsavedNote && (
          <li className="text-xs text-muted">No comments yet.</li>
        )}
        {comments.map((c) => {
          const chip = c.author_role ? roleChip[c.author_role] : undefined
          return (
            <li
              key={c.id}
              className="flex items-start gap-2 rounded-md border border-border p-2 bg-background/30"
            >
              <Avatar name={c.author_name} size="sm" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{c.author_name}</span>
                  {chip && (
                    <span
                      className={`text-[10px] px-1 py-0.5 rounded ${chip.className}`}
                    >
                      {chip.label}
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
      {canPost && !unsavedNote && (
        <div className="mt-3 flex gap-2 items-end">
          <Avatar name={meName} size="sm" />
          <div className="flex-1">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={placeholder}
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
      {unsavedNote && <p className="mt-2 text-xs text-muted">{unsavedNote}</p>}
    </div>
  )
}
