"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Trash2, Inbox } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Select, Textarea } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { cn, formatDate } from "@/lib/utils"
import {
  FEEDBACK_STATUSES,
  TYPE_TONE,
  STATUS_TONE,
  type FeedbackRow,
  type FeedbackStatus,
  type FeedbackType,
} from "@/lib/feedback"
import {
  updateFeedbackStatus,
  updateFeedbackNotes,
  deleteFeedback,
} from "@/app/actions/feedback"

type Filter = "All" | FeedbackStatus

export function FeedbackTable({
  rows,
  isStaff,
}: {
  rows: FeedbackRow[]
  isStaff: boolean
}) {
  const [filter, setFilter] = useState<Filter>("All")

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: rows.length }
    for (const s of FEEDBACK_STATUSES) c[s] = 0
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])

  const visible =
    filter === "All" ? rows : rows.filter((r) => r.status === filter)

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="h-10 w-10" />}
        title="No requests yet"
        description={
          isStaff
            ? "Requests submitted by your team and clients will show up here."
            : "Use “Request an update” in the top bar to submit your first request."
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["All", ...FEEDBACK_STATUSES] as Filter[]).map((f) => {
          const active = filter === f
          const count = counts[f] ?? 0
          const isNew = f === "New"
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border transition-colors cursor-pointer",
                active
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-border bg-surface text-muted hover:text-foreground hover:bg-background"
              )}
            >
              {f}
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs",
                  isNew && count > 0
                    ? "bg-danger text-white"
                    : "bg-background text-muted"
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-background/60 text-xs text-muted uppercase">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Date</th>
              {isStaff && (
                <th className="text-left font-medium px-4 py-2.5">
                  Submitted by
                </th>
              )}
              <th className="text-left font-medium px-4 py-2.5">Type</th>
              <th className="text-left font-medium px-4 py-2.5">Request</th>
              <th className="text-left font-medium px-4 py-2.5">Status</th>
              <th className="text-left font-medium px-4 py-2.5">Admin notes</th>
              {isStaff && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((row) => (
              // Key includes updated_at so the row remounts when staff edits
              // land server-side, re-seeding the notes editor with fresh data.
              <FeedbackTableRow
                key={`${row.id}-${row.updated_at}`}
                row={row}
                isStaff={isStaff}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FeedbackTableRow({
  row,
  isStaff,
}: {
  row: FeedbackRow
  isStaff: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [notes, setNotes] = useState(row.admin_notes ?? "")

  function handleStatus(status: FeedbackStatus) {
    startTransition(async () => {
      try {
        await updateFeedbackStatus({ id: row.id, status })
        toast.success("Status updated")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update status")
      }
    })
  }

  function handleNotesBlur() {
    const next = notes.trim()
    if (next === (row.admin_notes ?? "").trim()) return
    startTransition(async () => {
      try {
        await updateFeedbackNotes({ id: row.id, admin_notes: next || null })
        toast.success("Notes saved")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save notes")
      }
    })
  }

  function handleDelete() {
    if (!confirm("Delete this request? This can't be undone.")) return
    startTransition(async () => {
      try {
        await deleteFeedback({ id: row.id })
        toast.success("Request deleted")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete")
      }
    })
  }

  return (
    <tr className="align-top">
      <td className="px-4 py-3 text-muted whitespace-nowrap">
        {formatDate(row.created_at)}
      </td>
      {isStaff && (
        <td className="px-4 py-3">
          <div className="font-medium">{row.submitted_by}</div>
          {row.submitted_by_email && (
            <div className="text-xs text-muted">{row.submitted_by_email}</div>
          )}
        </td>
      )}
      <td className="px-4 py-3">
        <Badge tone={TYPE_TONE[row.request_type as FeedbackType] ?? "neutral"}>
          {row.request_type}
        </Badge>
      </td>
      <td className="px-4 py-3 max-w-sm">
        <div className="font-medium">{row.title}</div>
        {row.description && (
          <div className="text-xs text-muted whitespace-pre-wrap mt-0.5">
            {row.description}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {isStaff ? (
          <Select
            value={row.status}
            disabled={pending}
            onChange={(e) => handleStatus(e.target.value as FeedbackStatus)}
            className="h-8 w-36"
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        ) : (
          <Badge tone={STATUS_TONE[row.status as FeedbackStatus] ?? "neutral"}>
            {row.status}
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 max-w-xs">
        {isStaff ? (
          <Textarea
            value={notes}
            disabled={pending}
            rows={2}
            placeholder="Add a note…"
            className="min-h-[40px] text-xs"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
          />
        ) : row.admin_notes ? (
          <span className="text-xs whitespace-pre-wrap">{row.admin_notes}</span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </td>
      {isStaff && (
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={handleDelete}
            disabled={pending}
            className="text-muted hover:text-danger cursor-pointer disabled:opacity-50"
            title="Delete request"
            aria-label="Delete request"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </td>
      )}
    </tr>
  )
}
