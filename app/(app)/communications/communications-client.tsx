"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FolderOpen, MessagesSquare, Search } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { FeedItem } from "@/lib/comms/feed"
import { FeedItemRow } from "@/components/comms/feed-item"
import {
  ComposeMessageButton,
  type ComposeContact,
} from "@/components/comms/compose-dialog"
import {
  assignCommunication,
  ignoreCommunication,
} from "@/app/actions/communications"

const PAGE = 50

const KIND_FILTERS = [
  { key: "all", label: "All" },
  { key: "email", label: "Emails" },
  { key: "sms", label: "Texts" },
  { key: "call", label: "Calls" },
] as const

type KindFilter = (typeof KIND_FILTERS)[number]["key"]

type Project = { id: string; name: string; project_number: string }

type GlobalFeedItem = FeedItem & { projectName: string | null }

/**
 * Global Communications hub. Every call, text and email across the business,
 * searchable in one place. Nothing here demands attention: traffic captured
 * directly through Quo lands automatically, auto-filed to a job only when the
 * matcher is confident. Anything left unfiled just stays global and offers a
 * quiet, optional "file to job" (or "dismiss" for spam) — no review queue.
 */
export function GlobalCommunicationsClient({
  feed,
  projects,
  contacts,
}: {
  feed: GlobalFeedItem[]
  projects: Project[]
  contacts: ComposeContact[]
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
        (item.projectName ?? "").toLowerCase().includes(q)
      )
    })
  }, [feed, kind, query])

  const shown = filtered.slice(0, limit)

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Communications
          </h1>
          <p className="mt-0.5 text-xs text-muted">
            Every call, text and email across the business. Calls and texts
            land here automatically — no filing required. Search by person,
            message or job.
          </p>
        </div>
        <ComposeMessageButton contacts={contacts} projectId={null} />
      </header>

      <div className="flex items-center gap-2 flex-wrap">
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
            placeholder="Search people, messages, jobs…"
            className="pl-8"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-10 w-10" />}
          title={feed.length === 0 ? "No traffic logged yet" : "Nothing matches"}
          description={
            feed.length === 0
              ? "Emails, texts and calls across every job will show up here once messages start flowing."
              : "Try a different filter or search."
          }
        />
      ) : (
        <ul className="space-y-2">
          {shown.map((item) => (
            <li key={item.id} className="space-y-0.5">
              {item.projectId && (
                <Link
                  href={`/projects/${item.projectId}/communications`}
                  className="inline-block text-[11px] font-medium text-brand-600 hover:underline pl-1"
                >
                  {item.projectName ?? "View job"}
                </Link>
              )}
              <ul>
                <FeedItemRow
                  item={item}
                  projectId={item.projectId ?? ""}
                  canReply
                />
              </ul>
              {!item.projectId && item.id.startsWith("comm:") && (
                <UnfiledActions
                  communicationId={item.id.slice("comm:".length)}
                  projects={projects}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {filtered.length > limit && (
        <div className="text-center mt-3">
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
  )
}

/**
 * Optional per-message filing. Quo/email traffic that couldn't be tied to a
 * single job stays in this global log by default; staff can quietly file one
 * to a job when it matters, or dismiss obvious spam. Nothing here nags.
 */
function UnfiledActions({
  communicationId,
  projects,
}: {
  communicationId: string
  projects: Project[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState("")
  const [pending, startTransition] = useTransition()

  function file() {
    if (!projectId) return
    startTransition(async () => {
      try {
        await assignCommunication({
          communication_id: communicationId,
          project_id: projectId,
        })
        toast.success("Filed to job")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not file")
      }
    })
  }

  function dismiss() {
    startTransition(async () => {
      try {
        await ignoreCommunication({ communication_id: communicationId })
        toast.success("Dismissed")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not dismiss")
      }
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2 pl-1 text-[11px] text-muted">
        <span>Not filed to a job</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-brand-600 hover:underline cursor-pointer"
        >
          <FolderOpen className="h-3 w-3" />
          File to job
        </button>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className="hover:text-foreground hover:underline cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          Dismiss
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap pl-1">
      <Select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className="max-w-xs text-sm"
      >
        <option value="">Choose a job…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.project_number ? `#${p.project_number} — ` : ""}
            {p.name}
          </option>
        ))}
      </Select>
      <Button size="sm" onClick={file} disabled={pending || !projectId}>
        File
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss} disabled={pending}>
        Dismiss
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false)
          setProjectId("")
        }}
        disabled={pending}
      >
        Cancel
      </Button>
    </div>
  )
}
