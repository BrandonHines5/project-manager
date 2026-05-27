"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Plus,
  Search,
  Filter as FilterIcon,
  ChevronDown,
  Calendar,
  ClipboardList,
  ScrollText,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export type SidebarProject = {
  id: string
  name: string
  project_number: string
  address: string | null
  status: Enums<"project_status">
}

type StatusFilter = "open" | "active" | "closed" | "all"
type Mode = "jobs" | "templates"

// Templates are projects whose project_number starts with "TEMPLATE" — staff
// convention rather than a DB column. Keep the check case-insensitive so
// "TEMPLATE-NHT" and "template-foo" both qualify.
function isTemplate(p: SidebarProject) {
  return p.project_number.toUpperCase().startsWith("TEMPLATE")
}

const OPEN_STATUSES: ReadonlyArray<Enums<"project_status">> = [
  "lead",
  "pre_construction",
  "active",
  "on_hold",
]

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  lead: "Lead",
  pre_construction: "Pre",
  active: "Active",
  on_hold: "On hold",
  complete: "Complete",
  cancelled: "Cancelled",
}

const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  lead: "muted",
  pre_construction: "info",
  active: "brand",
  on_hold: "warning",
  complete: "success",
  cancelled: "danger",
}

const STORAGE_KEY = "hh.projectSelection.v1"

/**
 * Persistent project picker that sits between the main nav and page content
 * on all project-context routes. Single-click navigates to a project (carrying
 * the user's current sub-route — schedule → schedule, etc.); checkboxes drive
 * a multi-select used by the /all/* aggregate views.
 *
 * Selection state lives in localStorage so the user can build a multi-select
 * up across navigations and the aggregate pages can hydrate it via the URL.
 */
export function ProjectListSidebar({
  projects,
}: {
  projects: SidebarProject[]
}) {
  const router = useRouter()
  const pathname = usePathname()

  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("open")
  const [statusOpen, setStatusOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("jobs")
  // Initialized empty; hydrated from localStorage on mount so SSR markup
  // stays deterministic (avoids hydration mismatch).
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [hydrated, setHydrated] = useState(false)

  // Derive both the current project and the current sub-route from the
  // pathname so clicking a different project keeps the user on the same tab
  // (i.e. /projects/A/daily-logs → /projects/B/daily-logs). On /all/* there's
  // no "current project" — every list item is unhighlighted.
  const { currentProjectId, currentSubRoute } = useMemo(() => {
    const m = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/)
    return {
      currentProjectId: m?.[1] ?? null,
      currentSubRoute: m?.[2] ?? "schedule",
    }
  }, [pathname])

  /* eslint-disable react-hooks/set-state-in-effect --
     One-time hydration from localStorage on mount. We deliberately keep
     SSR-rendered markup deterministic (empty selection) and apply the
     restored state once the client has hydrated; useSyncExternalStore would
     be cleaner if selection were truly external, but it's owned by this
     component and only READ from storage on mount. */
  useEffect(() => {
    setHydrated(true)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const ids = JSON.parse(raw) as string[]
        if (Array.isArray(ids)) {
          // Drop any IDs that no longer exist (project deleted, RLS hid it).
          const known = new Set(projects.map((p) => p.id))
          setSelected(new Set(ids.filter((id) => known.has(id))))
        }
      }
    } catch {
      // localStorage unavailable or corrupted — start empty.
    }
  }, [projects])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(selected)))
    } catch {
      // Ignore quota / disabled storage.
    }
  }, [selected, hydrated])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      const tpl = isTemplate(p)
      if (mode === "templates" && !tpl) return false
      if (mode === "jobs" && tpl) return false
      // Status filter applies to Jobs only — templates are few and the status
      // (usually "lead") isn't a meaningful filter for them.
      if (mode === "jobs") {
        if (status === "open" && !OPEN_STATUSES.includes(p.status)) return false
        if (status === "active" && p.status !== "active") return false
        if (status === "closed" && OPEN_STATUSES.includes(p.status)) return false
      }
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.project_number.toLowerCase().includes(q) ||
        (p.address?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [projects, query, status, mode])

  const visibleIds = useMemo(() => filtered.map((p) => p.id), [filtered])
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id)
      } else {
        for (const id of visibleIds) next.add(id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
  }

  function navigateToAggregate(section: "schedule" | "daily-logs" | "decisions") {
    const ids = Array.from(selected).join(",")
    router.push(`/all/${section}?ids=${ids}`)
  }

  const filterLabel =
    status === "open"
      ? "Open"
      : status === "active"
        ? "Active"
        : status === "closed"
          ? "Closed"
          : "All"

  return (
    <aside className="hidden lg:flex lg:flex-col w-[300px] shrink-0 border-r border-border bg-surface">
      {/* Workspace header */}
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <div className="text-sm font-semibold">Hines Homes</div>
      </div>

      {/* Tabs + + Job */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <div className="flex-1 inline-flex rounded-md border border-border bg-background p-0.5">
          <button
            type="button"
            onClick={() => setMode("jobs")}
            className={cn(
              "flex-1 px-3 py-1 text-xs font-medium rounded cursor-pointer",
              mode === "jobs"
                ? "bg-surface shadow-sm"
                : "text-muted hover:text-foreground"
            )}
          >
            Jobs
          </button>
          <button
            type="button"
            onClick={() => setMode("templates")}
            className={cn(
              "flex-1 px-3 py-1 text-xs font-medium rounded cursor-pointer",
              mode === "templates"
                ? "bg-surface shadow-sm"
                : "text-muted hover:text-foreground"
            )}
          >
            Templates
          </button>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium px-2.5 py-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Job
        </Link>
      </div>

      {/* Search + filter row */}
      <div className="px-3 pb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full h-8 pl-7 pr-2 text-sm rounded-md border border-border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          />
        </div>
        <div className={cn("relative", mode === "templates" && "hidden")}>
          <button
            type="button"
            onClick={() => setStatusOpen((s) => !s)}
            className={cn(
              "h-8 px-2 inline-flex items-center gap-1 rounded-md border border-border bg-background text-xs font-medium",
              status !== "open" && "border-brand-500 text-brand-700"
            )}
            title="Status filter"
          >
            <FilterIcon className="h-3.5 w-3.5" />
            <ChevronDown className="h-3 w-3" />
          </button>
          {statusOpen && (
            <div className="absolute right-0 top-9 z-20 w-36 rounded-md border border-border bg-surface shadow-md py-1 text-sm">
              {(["open", "active", "closed", "all"] as StatusFilter[]).map(
                (s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setStatus(s)
                      setStatusOpen(false)
                    }}
                    className={cn(
                      "block w-full text-left px-3 py-1.5 capitalize hover:bg-background",
                      status === s && "font-medium text-brand-700"
                    )}
                  >
                    {s}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* List header w/ select-all */}
      <div className="px-3 pt-2 pb-1 flex items-center justify-between border-t border-border">
        <label className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => {
              if (el) el.indeterminate = someVisibleSelected
            }}
            onChange={toggleAllVisible}
            className="h-3.5 w-3.5 rounded border-border accent-brand-500"
          />
          {mode === "templates"
            ? `All templates (${filtered.length})`
            : `All ${filterLabel} jobs (${filtered.length})`}
        </label>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted text-center">
            No projects match.
          </div>
        ) : (
          <ul>
            {filtered.map((p) => {
              const isCurrent = p.id === currentProjectId
              const isSelected = selected.has(p.id)
              const projectHref = `/projects/${p.id}/${currentSubRoute}`
              return (
                <li
                  key={p.id}
                  className={cn(
                    "group relative flex items-center gap-2 px-3 py-2 border-b border-border/60 text-sm hover:bg-background/60",
                    isCurrent && "bg-brand-50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(p.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${p.project_number}`}
                    className="h-3.5 w-3.5 rounded border-border accent-brand-500 shrink-0"
                  />
                  <Link
                    href={projectHref}
                    className="flex-1 min-w-0 leading-tight"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-[11px] text-muted shrink-0">
                        {p.project_number}
                      </span>
                      <span className="truncate">{p.name}</span>
                    </div>
                  </Link>
                  <Badge tone={STATUS_TONE[p.status]} className="text-[10px] py-0">
                    {STATUS_LABEL[p.status]}
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Selection footer */}
      {hydrated && selected.size > 0 && (
        <SelectionFooter
          count={selected.size}
          onClear={clearSelection}
          onNavigate={navigateToAggregate}
        />
      )}
    </aside>
  )
}

function SelectionFooter({
  count,
  onClear,
  onNavigate,
}: {
  count: number
  onClear: () => void
  onNavigate: (section: "schedule" | "daily-logs" | "decisions") => void
}) {
  return (
    <div className="border-t border-border bg-surface shadow-lg">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-xs font-medium">
          {count} selected
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
          title="Clear selection"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div className="grid grid-cols-3 border-t border-border">
        <FooterButton
          icon={<Calendar className="h-3.5 w-3.5" />}
          label="Schedule"
          onClick={() => onNavigate("schedule")}
        />
        <FooterButton
          icon={<ScrollText className="h-3.5 w-3.5" />}
          label="Daily Logs"
          onClick={() => onNavigate("daily-logs")}
        />
        <FooterButton
          icon={<ClipboardList className="h-3.5 w-3.5" />}
          label="Decisions"
          onClick={() => onNavigate("decisions")}
        />
      </div>
    </div>
  )
}

function FooterButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium border-l border-border first:border-l-0 hover:bg-background/60"
    >
      {icon}
      {label}
    </button>
  )
}
