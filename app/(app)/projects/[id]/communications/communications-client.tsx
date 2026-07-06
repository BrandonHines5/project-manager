"use client"

import { useMemo, useState } from "react"
import { MessagesSquare, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { FeedItem } from "@/lib/comms/feed"
import { FeedItemRow } from "@/components/comms/feed-item"
import type { UserRole } from "@/lib/auth"

const PAGE = 50

const KIND_FILTERS = [
  { key: "all", label: "All" },
  { key: "comment", label: "Comments" },
  { key: "email", label: "Emails" },
  { key: "sms", label: "Texts" },
  { key: "call", label: "Calls" },
] as const

type KindFilter = (typeof KIND_FILTERS)[number]["key"]

export function CommunicationsClient({
  feed,
  projectId,
  role,
}: {
  feed: FeedItem[]
  projectId: string
  role: UserRole
}) {
  const [kind, setKind] = useState<KindFilter>("all")
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(PAGE)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return feed.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false
      if (!q) return true
      return (
        item.author.name.toLowerCase().includes(q) ||
        item.body.toLowerCase().includes(q) ||
        (item.subject ?? "").toLowerCase().includes(q) ||
        (item.entity?.label ?? "").toLowerCase().includes(q)
      )
    })
  }, [feed, kind, query])

  const shown = filtered.slice(0, limit)

  // Group by calendar day for scannability.
  const groups = useMemo(() => {
    const out: { day: string; items: FeedItem[] }[] = []
    for (const item of shown) {
      const day = new Date(item.occurredAt).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(item)
      else out.push({ day, items: [item] })
    }
    return out
  }, [shown])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: feed.length }
    for (const item of feed) c[item.kind] = (c[item.kind] ?? 0) + 1
    return c
  }, [feed])

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <div className="flex gap-1">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setKind(f.key)
                setLimit(PAGE)
              }}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                kind === f.key
                  ? "bg-brand-500 text-white border-brand-500"
                  : "bg-surface text-muted border-border hover:text-foreground"
              )}
            >
              {f.label}
              {counts[f.key] != null && counts[f.key] > 0 && (
                <span className="ml-1 tabular-nums">{counts[f.key]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE)
            }}
            placeholder="Search people, messages…"
            className="pl-8"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-10 w-10" />}
          title={
            feed.length === 0 ? "No communication yet" : "Nothing matches"
          }
          description={
            feed.length === 0
              ? "Comments on schedule items, job logs, decisions, bids and POs — plus emails and texts — will all show up here."
              : "Try a different filter or search."
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-background/95 backdrop-blur-sm text-xs font-semibold text-muted uppercase tracking-wide">
                {g.day}
              </div>
              <ul className="mt-1.5 space-y-2">
                {g.items.map((item) => (
                  <FeedItemRow
                    key={item.id}
                    item={item}
                    projectId={projectId}
                    canReply={role === "staff"}
                  />
                ))}
              </ul>
            </div>
          ))}
          {filtered.length > limit && (
            <div className="text-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setLimit((l) => l + PAGE)}
              >
                Show more ({filtered.length - limit} older)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
