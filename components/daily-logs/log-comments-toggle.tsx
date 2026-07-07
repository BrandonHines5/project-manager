"use client"

import { useState } from "react"
import { MessageSquare } from "lucide-react"
import {
  CommentsThread,
  type ThreadComment,
} from "@/components/comms/comments-thread"
import { postDailyLogComment } from "@/app/actions/daily-logs"

/**
 * Expandable comment thread for a job log card. Shared between the
 * per-project Job Logs page and the all-jobs aggregate so both surfaces
 * offer the same staff↔client conversation (RLS decides who can read/post:
 * staff always, clients only on client-visible logs of their projects).
 */
export function LogCommentsToggle({
  dailyLogId,
  projectId,
  comments,
  meName,
  canPost,
  placeholder,
  initialOpen = false,
}: {
  dailyLogId: string
  projectId: string
  comments: ThreadComment[]
  meName: string
  canPost: boolean
  placeholder: string
  initialOpen?: boolean
}) {
  const [show, setShow] = useState(initialOpen)
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="text-xs text-brand-600 hover:underline cursor-pointer inline-flex items-center gap-1"
      >
        <MessageSquare className="h-3 w-3" />
        {comments.length > 0
          ? `Comments (${comments.length})`
          : "Add a comment"}
      </button>
      {show && (
        <div className="mt-2">
          <CommentsThread
            comments={comments}
            meName={meName}
            canPost={canPost}
            hideHeader
            placeholder={placeholder}
            onPost={(body) =>
              postDailyLogComment({
                daily_log_id: dailyLogId,
                project_id: projectId,
                body,
              })
            }
          />
        </div>
      )}
    </div>
  )
}
