"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Inbox, ArrowRight } from "lucide-react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"

// Staff-only dashboard banner: how many requests are still sitting at "New".
// Polls every 60s (RLS lets staff read every request). Renders nothing when
// there's nothing waiting.
export function FeedbackNotification() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    let cancelled = false

    async function load() {
      const { count } = await supabase
        .from("feedback_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "New")
      if (!cancelled) setCount(count ?? 0)
    }

    load()
    const interval = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (count === 0) return null

  return (
    <Link
      href="/feedback"
      className="mb-6 flex items-center gap-3 rounded-lg border border-danger/30 bg-red-50 px-4 py-3 text-sm text-red-800 hover:bg-red-100 transition-colors"
    >
      <Inbox className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {count} new feedback {count === 1 ? "request" : "requests"} waiting for
        review
      </span>
      <ArrowRight className="h-4 w-4 ml-auto shrink-0" />
    </Link>
  )
}
