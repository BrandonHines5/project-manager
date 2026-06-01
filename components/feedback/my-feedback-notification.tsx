"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  STATUS_TONE,
  hasResponse,
  responseSignature,
  type FeedbackRow,
  type FeedbackStatus,
} from "@/lib/feedback"

type SeenMap = Record<string, string>

// Submitter's dashboard panel: their own requests that staff have responded to
// (moved off "New" or left a note). A red badge counts responses the user
// hasn't looked at yet — tracked per-user in localStorage so it survives
// reloads — and opening the panel marks everything seen. Renders nothing until
// at least one request has a response.
export function MyFeedbackNotification({ userId }: { userId: string }) {
  // Key on the (non-PII) profile id rather than the email so we don't persist
  // an address into browser storage on shared devices.
  const storageKey = `feedbackSeen:${userId}`

  const [rows, setRows] = useState<FeedbackRow[]>([])
  const [open, setOpen] = useState(false)
  // Hydrate the last-seen signatures from localStorage on first render. Guarded
  // for SSR; there's no hydration mismatch because the panel renders null until
  // rows load client-side anyway.
  const [seen, setSeen] = useState<SeenMap>(() => {
    if (typeof window === "undefined") return {}
    try {
      const raw = window.localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as SeenMap) : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    let cancelled = false

    async function load() {
      const { data } = await supabase
        .from("feedback_requests")
        .select("*")
        .eq("submitted_by_id", userId)
        .order("created_at", { ascending: false })
      if (!cancelled) setRows(data ?? [])
    }

    load()
    const interval = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [userId])

  const responded = rows.filter(hasResponse)

  const unseenCount = responded.reduce((n, r) => {
    return seen[r.id] === responseSignature(r) ? n : n + 1
  }, 0)

  // Mark every currently-responded request as seen and persist.
  const markSeen = useCallback(() => {
    const next: SeenMap = { ...seen }
    for (const r of responded) next[r.id] = responseSignature(r)
    setSeen(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Best-effort; the badge will just reappear next load.
    }
  }, [responded, seen, storageKey])

  function toggle() {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen && unseenCount > 0) markSeen()
  }

  if (responded.length === 0) return null

  return (
    <div className="mb-6 rounded-lg border border-border bg-surface overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm hover:bg-background transition-colors cursor-pointer"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted" />
        )}
        <MessageSquare className="h-4 w-4 text-brand-600" />
        <span className="font-medium">Updates on your requests</span>
        {unseenCount > 0 && (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs text-white">
            {unseenCount}
          </span>
        )}
        <span className="ml-auto text-xs text-muted">
          {responded.length} {responded.length === 1 ? "request" : "requests"}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {responded.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[r.status as FeedbackStatus] ?? "neutral"}>
                  {r.status}
                </Badge>
                <span className="font-medium text-sm">{r.title}</span>
                <span className="ml-auto text-xs text-muted">
                  {r.request_type}
                </span>
              </div>
              {r.admin_notes && (
                <p
                  className={cn(
                    "mt-1.5 rounded-md bg-background px-3 py-2 text-xs whitespace-pre-wrap"
                  )}
                >
                  {r.admin_notes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
