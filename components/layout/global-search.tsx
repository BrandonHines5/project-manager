"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter, usePathname } from "next/navigation"
import {
  Search,
  Loader2,
  FolderOpen,
  CalendarDays,
  Scale,
  Palette,
  FileText,
  MessageSquare,
  CheckSquare,
  FileIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { globalSearch, type SearchResult, type SearchResultType } from "@/app/actions/search"

const TYPE_ICON: Record<SearchResultType, React.ComponentType<{ className?: string }>> = {
  project: FolderOpen,
  work_item: CalendarDays,
  todo: CheckSquare,
  decision: Scale,
  decision_choice: Palette,
  daily_log: FileText,
  decision_comment: MessageSquare,
  project_file: FileIcon,
}

const TYPE_GROUP_LABEL: Record<SearchResultType, string> = {
  project: "Projects",
  work_item: "Work items",
  todo: "To-dos",
  decision: "Decisions",
  decision_choice: "Selection choices",
  daily_log: "Daily logs",
  decision_comment: "Comments",
  project_file: "Files",
}

// Order results are rendered in. Projects and active items first, then
// reference / context items below.
const TYPE_ORDER: SearchResultType[] = [
  "project",
  "work_item",
  "todo",
  "decision",
  "decision_choice",
  "daily_log",
  "decision_comment",
  "project_file",
]

export function GlobalSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<"current" | "all">("current")
  const [results, setResults] = useState<SearchResult[]>([])
  const [pending, startTransition] = useTransition()
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Pull the current project id out of the URL — used for the "this project"
  // scope toggle. If the user isn't on a project page, we treat the scope as
  // "all" without mutating the stored preference, so it snaps back when they
  // navigate into a project again.
  const currentProjectId = useMemo(() => {
    const m = pathname?.match(/^\/projects\/([0-9a-f-]{36})/)
    return m ? m[1] : null
  }, [pathname])
  const effectiveScope: "current" | "all" = currentProjectId ? scope : "all"

  // Opening the dialog also clears the previous query / results so a stale
  // result list doesn't flash before the debounced re-query fires. Done in
  // the event handler instead of an effect-on-`open` so React doesn't double
  // render and ESLint doesn't trip on `set-state-in-effect`.
  const openDialog = useCallback(() => {
    setQuery("")
    setResults([])
    setActiveIdx(0)
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])
  const closeDialog = useCallback(() => setOpen(false), [])

  // Global Cmd+K / Ctrl+K toggles the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (open) closeDialog()
        else openDialog()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, openDialog, closeDialog])

  const trimmedQuery = query.trim()
  const isQueryReady = trimmedQuery.length >= 2

  // Debounce queries by 200ms so we're not pinging the action on every
  // keystroke. Cancel via a closure flag so a slow request can't overwrite
  // the latest results. State writes happen inside the async callback (which
  // is run asynchronously inside startTransition) — not synchronously in
  // the effect body, so React's set-state-in-effect rule is fine with this.
  useEffect(() => {
    if (!open || !isQueryReady) return
    let cancelled = false
    const t = setTimeout(() => {
      startTransition(async () => {
        try {
          const r = await globalSearch({
            query: trimmedQuery,
            scope: effectiveScope,
            project_id: currentProjectId,
          })
          if (!cancelled) {
            setResults(r)
            setActiveIdx(0)
          }
        } catch {
          if (!cancelled) setResults([])
        }
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [trimmedQuery, effectiveScope, open, currentProjectId, isQueryReady])

  const grouped = useMemo(() => {
    const map = new Map<SearchResultType, SearchResult[]>()
    for (const r of results) {
      const arr = map.get(r.type) ?? []
      arr.push(r)
      map.set(r.type, arr)
    }
    // Flatten back in TYPE_ORDER so keyboard navigation matches the visual
    // order.
    const flat: SearchResult[] = []
    const groups: Array<{ type: SearchResultType; items: SearchResult[]; startIdx: number }> = []
    for (const t of TYPE_ORDER) {
      const items = map.get(t)
      if (!items?.length) continue
      groups.push({ type: t, items, startIdx: flat.length })
      flat.push(...items)
    }
    return { flat, groups }
  }, [results])

  function navigateTo(r: SearchResult) {
    setOpen(false)
    router.push(r.href)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(grouped.flat.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = grouped.flat[activeIdx]
      if (r) navigateTo(r)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong bg-background/40 px-2.5 text-sm text-muted hover:bg-background hover:text-foreground transition-colors cursor-pointer min-w-0 sm:w-72"
        aria-label="Search"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline truncate">Search projects, items…</span>
        <kbd className="ml-auto hidden sm:inline rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" className="sm:max-h-[80vh]">
          <DialogHeader>
            <div className="flex-1">
              <DialogTitle>Search</DialogTitle>
              <div className="mt-3 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted pointer-events-none" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search…"
                    className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                  />
                  {pending && (
                    <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted animate-spin" />
                  )}
                </div>
                <ScopeToggle
                  scope={effectiveScope}
                  onChange={setScope}
                  disabled={!currentProjectId}
                />
              </div>
            </div>
          </DialogHeader>
          <DialogBody className="p-0">
            {!isQueryReady ? (
              <EmptyHint />
            ) : grouped.flat.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-muted">
                {pending ? "Searching…" : "No matches."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {grouped.groups.map((g) => (
                  <li key={g.type}>
                    <div className="bg-background/60 px-4 py-1.5 text-[10px] uppercase tracking-wide font-medium text-muted">
                      {TYPE_GROUP_LABEL[g.type]}
                    </div>
                    <ul>
                      {g.items.map((r, i) => {
                        const flatIdx = g.startIdx + i
                        const Icon = TYPE_ICON[r.type]
                        return (
                          <li key={`${r.type}-${r.id}`}>
                            <button
                              type="button"
                              onClick={() => navigateTo(r)}
                              onMouseEnter={() => setActiveIdx(flatIdx)}
                              className={cn(
                                "w-full text-left px-4 py-2.5 flex items-start gap-3 cursor-pointer",
                                flatIdx === activeIdx
                                  ? "bg-brand-50"
                                  : "hover:bg-background/40"
                              )}
                            >
                              <Icon className="h-4 w-4 text-muted mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2">
                                  <span className="text-sm font-medium truncate">
                                    {r.title}
                                  </span>
                                  {r.meta && (
                                    <span className="text-[11px] text-muted shrink-0">
                                      {r.meta}
                                    </span>
                                  )}
                                </div>
                                {r.snippet && (
                                  <div className="text-xs text-muted mt-0.5 line-clamp-2">
                                    {r.snippet}
                                  </div>
                                )}
                                {effectiveScope === "all" && r.project_name && (
                                  <div className="text-[11px] text-muted mt-0.5">
                                    {r.project_name}
                                    {r.project_number && ` · #${r.project_number}`}
                                  </div>
                                )}
                              </div>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ScopeToggle({
  scope,
  onChange,
  disabled,
}: {
  scope: "current" | "all"
  onChange: (v: "current" | "all") => void
  disabled: boolean
}) {
  return (
    <div className="inline-flex rounded-md border border-border-strong bg-surface text-xs h-9 shrink-0">
      <button
        type="button"
        onClick={() => onChange("current")}
        disabled={disabled}
        className={cn(
          "px-2.5 rounded-l-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
          scope === "current" && !disabled
            ? "bg-brand-500 text-white"
            : "text-muted hover:text-foreground"
        )}
        title={disabled ? "Open a project to search within it" : undefined}
      >
        This project
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "px-2.5 rounded-r-md cursor-pointer",
          scope === "all"
            ? "bg-brand-500 text-white"
            : "text-muted hover:text-foreground"
        )}
      >
        All projects
      </button>
    </div>
  )
}

function EmptyHint() {
  return (
    <div className="px-6 py-10 text-center text-sm text-muted">
      <Search className="h-6 w-6 mx-auto text-muted/60 mb-2" />
      Type at least two characters to search across projects, schedule items,
      decisions, daily logs, comments, and files.
    </div>
  )
}
