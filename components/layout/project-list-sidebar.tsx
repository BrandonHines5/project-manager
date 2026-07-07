"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Plus,
  Search,
  Filter as FilterIcon,
  ChevronDown,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Tag,
  RefreshCw,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { setProjectLabel } from "@/app/actions/projects"
import { syncProjectsFromCrm } from "@/app/actions/crm-sync"
import { crmStatusTone } from "@/lib/crm-status"
import { OPEN_STATUSES, aggregateRouteForSlug } from "@/lib/project-status"
import type { Enums } from "@/lib/db/types"

// The label used to flag leftover test jobs. Surfaced as its own filter in the
// dropdown and toggled in bulk from the multi-select footer.
const TEST_LABEL = "Test"

export type SidebarProject = {
  id: string
  name: string
  project_number: string
  address: string | null
  status: Enums<"project_status">
  // Verbatim project_status pulled from the CRM (e.g. "In Work", "Inventory").
  // When present it's what the status badge shows; `status` (the enum) still
  // drives the Open/Active/Warranty/Closed filter below.
  crm_status: string | null
  labels: string[]
}

type StatusFilter = "open" | "active" | "warranty" | "closed" | "all"
type Mode = "jobs" | "templates"

const STATUS_FILTERS: ReadonlyArray<StatusFilter> = [
  "open",
  "active",
  "warranty",
  "closed",
  "all",
]

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  open: "Open",
  active: "Active",
  warranty: "Warranty",
  closed: "Closed",
  all: "All",
}

// A label filter is encoded as "label:<name>" so it can share the single filter
// dropdown with the status filters above.
const LABEL_PREFIX = "label:"

// Templates are projects whose project_number starts with "TEMPLATE" — staff
// convention rather than a DB column. Keep the check case-insensitive so
// "TEMPLATE-NHT" and "template-foo" both qualify.
function isTemplate(p: SidebarProject) {
  return p.project_number.toUpperCase().startsWith("TEMPLATE")
}

// The enum mirrors the CRM's statuses, so labels are the CRM's exact words
// (and tones match crmStatusTone so synced and un-synced jobs look alike).
const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  upcoming: "Upcoming",
  in_work: "In Work",
  inventory: "Inventory",
  paused: "Paused",
  complete: "Complete",
  warranty: "Warranty",
  cancelled: "Cancelled",
}

const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  upcoming: "info",
  in_work: "brand",
  inventory: "info",
  paused: "warning",
  complete: "success",
  warranty: "info",
  cancelled: "danger",
}

const STORAGE_KEY = "hh.projectSelection.v1"
const COLLAPSE_KEY = "hh.jobsListCollapsed.v1"

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
  canSync = false,
}: {
  projects: SidebarProject[]
  // Staff-only: shows the "Sync from CRM" button. The server action is
  // requireStaff-guarded regardless, so this only controls visibility.
  canSync?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()

  const [query, setQuery] = useState("")
  // Either a StatusFilter value ("open"…"all") or a "label:<name>" string.
  const [filter, setFilter] = useState<string>("open")
  const [statusOpen, setStatusOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("jobs")
  const [tagPending, startTag] = useTransition()
  const [syncPending, startSync] = useTransition()
  // Initialized empty; hydrated from localStorage on mount so SSR markup
  // stays deterministic (avoids hydration mismatch).
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [hydrated, setHydrated] = useState(false)
  // Collapsed = a thin rail so a job can take up (nearly) the whole screen.
  // SSR renders expanded; the stored preference applies after hydration.
  const [collapsed, setCollapsed] = useState(false)

  // Derive both the current project and the current sub-route from the
  // pathname so clicking a different project keeps the user on the same tab
  // (i.e. /projects/A/daily-logs → /projects/B/daily-logs). On /all/* and
  // /communications there's no "current project", but the section still
  // carries (/all/daily-logs → /projects/X/daily-logs; the Communications
  // hub → /projects/X/communications).
  const { currentProjectId, currentSubRoute } = useMemo(() => {
    const m = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/)
    const all = pathname.match(/^\/all\/([^/]+)/)
    const onComms =
      pathname === "/communications" || pathname.startsWith("/communications/")
    return {
      currentProjectId: m?.[1] ?? null,
      currentSubRoute:
        m?.[2] ?? all?.[1] ?? (onComms ? "communications" : "schedule"),
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
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1")
    } catch {
      // Ignore — stay expanded.
    }
  }, [projects])
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0")
      } catch {
        // Ignore quota / disabled storage.
      }
      return next
    })
  }

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(selected)))
    } catch {
      // Ignore quota / disabled storage.
    }
  }, [selected, hydrated])

  // Distinct labels in use across jobs (templates excluded), so any label that
  // exists on a job automatically becomes a filter option in the dropdown.
  const jobLabels = useMemo(() => {
    const set = new Set<string>()
    for (const p of projects) {
      if (isTemplate(p)) continue
      for (const l of p.labels ?? []) set.add(l)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [projects])

  const activeLabel = filter.startsWith(LABEL_PREFIX)
    ? filter.slice(LABEL_PREFIX.length)
    : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      const tpl = isTemplate(p)
      if (mode === "templates" && !tpl) return false
      if (mode === "jobs" && tpl) return false
      // Status / label filters apply to Jobs only — templates are few and the
      // status (usually "upcoming") isn't a meaningful filter for them.
      if (mode === "jobs") {
        if (activeLabel) {
          if (!(p.labels ?? []).includes(activeLabel)) return false
        } else {
          // "Active" = a live build: In Work or Inventory (same pair the old
          // enum collapsed into its single 'active' value).
          if (filter === "open" && !OPEN_STATUSES.includes(p.status)) return false
          if (filter === "active" && p.status !== "in_work" && p.status !== "inventory")
            return false
          if (filter === "warranty" && p.status !== "warranty") return false
          if (filter === "closed" && OPEN_STATUSES.includes(p.status)) return false
        }
      }
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.project_number.toLowerCase().includes(q) ||
        (p.address?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [projects, query, filter, activeLabel, mode])

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

  // Jump to the all-jobs view scoped to the checked jobs, keeping the user's
  // current section (schedule stays schedule, job logs stay job logs, …).
  function viewSelectedTogether() {
    const ids = Array.from(selected).join(",")
    router.push(`${aggregateRouteForSlug(currentSubRoute)}?ids=${ids}`)
  }

  // Add or remove the "Test" label across the current multi-select. The server
  // action is idempotent per project, so re-tagging an already-tagged job is a
  // no-op and the toast reports only the count that actually changed.
  function tagSelected(value: boolean) {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    startTag(async () => {
      try {
        const res = await setProjectLabel({ ids, label: TEST_LABEL, value })
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        const n = res.updated
        toast.success(
          value
            ? `Tagged ${n} job${n === 1 ? "" : "s"} as ${TEST_LABEL}`
            : `Removed ${TEST_LABEL} from ${n} job${n === 1 ? "" : "s"}`
        )
        router.refresh()
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Could not update labels"
        )
      }
    })
  }

  // Pull each job's status + official name from the CRM (matched by project
  // number) and refresh so the list reflects it. The action is idempotent, so
  // clicking twice is harmless.
  function runSync() {
    startSync(async () => {
      try {
        const res = await syncProjectsFromCrm()
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        const bits = [`Synced ${res.matched} job${res.matched === 1 ? "" : "s"}`]
        if (res.statusChanged > 0)
          bits.push(`${res.statusChanged} status${res.statusChanged === 1 ? "" : "es"} updated`)
        if (res.nameChanged > 0)
          bits.push(`${res.nameChanged} name${res.nameChanged === 1 ? "" : "s"} updated`)
        if (res.unmatched.length > 0)
          bits.push(`${res.unmatched.length} not found in CRM`)
        toast.success(bits.join(" · "))
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not sync from CRM")
      }
    })
  }

  const filterLabel =
    activeLabel ?? STATUS_FILTER_LABEL[filter as StatusFilter] ?? "All"

  // Collapsed: a thin rail with just an expand handle, so the job page can
  // take up (nearly) the full screen. Desktop-only, like the full list.
  if (collapsed) {
    return (
      <aside className="hidden lg:flex flex-col items-center w-10 shrink-0 border-r border-border bg-surface pt-2 gap-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          title="Show jobs list"
          aria-label="Show jobs list"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground cursor-pointer"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted [writing-mode:vertical-rl]">
          Jobs ({filtered.length})
        </span>
      </aside>
    )
  }

  return (
    <aside className="hidden lg:flex lg:flex-col w-[300px] shrink-0 border-r border-border bg-surface">
      {/* Workspace header */}
      <div className="pl-4 pr-2 pt-3 pb-2 border-b border-border flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Hines Homes</div>
        <div className="flex items-center gap-1">
          {canSync && (
            <button
              type="button"
              onClick={runSync}
              disabled={syncPending}
              title="Pull the latest statuses and job names from the CRM"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3 w-3", syncPending && "animate-spin")} />
              {syncPending ? "Syncing…" : "Sync from CRM"}
            </button>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Hide jobs list"
            aria-label="Hide jobs list"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground cursor-pointer"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
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
              filter !== "open" && "border-brand-500 text-brand-700"
            )}
            title="Filter jobs"
          >
            <FilterIcon className="h-3.5 w-3.5" />
            <ChevronDown className="h-3 w-3" />
          </button>
          {statusOpen && (
            <div className="absolute right-0 top-9 z-20 w-40 rounded-md border border-border bg-surface shadow-md py-1 text-sm">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setFilter(s)
                    setStatusOpen(false)
                  }}
                  className={cn(
                    "block w-full text-left px-3 py-1.5 hover:bg-background",
                    filter === s && "font-medium text-brand-700"
                  )}
                >
                  {STATUS_FILTER_LABEL[s]}
                </button>
              ))}
              {jobLabels.length > 0 && (
                <>
                  <div className="my-1 border-t border-border" />
                  <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted">
                    Labels
                  </div>
                  {jobLabels.map((l) => {
                    const key = `${LABEL_PREFIX}${l}`
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setFilter(key)
                          setStatusOpen(false)
                        }}
                        className={cn(
                          "flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-background",
                          filter === key && "font-medium text-brand-700"
                        )}
                      >
                        <Tag className="h-3 w-3 shrink-0" />
                        {l}
                      </button>
                    )
                  })}
                </>
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
                  <div className="flex shrink-0 items-center gap-1">
                    {(p.labels ?? []).map((l) => (
                      <Badge
                        key={l}
                        tone="warning"
                        className="text-[10px] py-0"
                      >
                        {l}
                      </Badge>
                    ))}
                    {/* Show the CRM's exact status word when synced; fall back
                        to PM's own label for jobs with no CRM match. */}
                    {p.crm_status ? (
                      <Badge
                        tone={crmStatusTone(p.crm_status)}
                        className="text-[10px] py-0"
                      >
                        {p.crm_status}
                      </Badge>
                    ) : (
                      <Badge
                        tone={STATUS_TONE[p.status]}
                        className="text-[10px] py-0"
                      >
                        {STATUS_LABEL[p.status]}
                      </Badge>
                    )}
                  </div>
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
          pending={tagPending}
          onClear={clearSelection}
          onTag={tagSelected}
          onViewTogether={viewSelectedTogether}
        />
      )}
    </aside>
  )
}

function SelectionFooter({
  count,
  pending,
  onClear,
  onTag,
  onViewTogether,
}: {
  count: number
  pending: boolean
  onClear: () => void
  onTag: (value: boolean) => void
  onViewTogether: () => void
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
      {/* One combined view for the checked jobs; the tabs across the top
          switch sections once there. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onViewTogether}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium px-2.5 py-1.5 cursor-pointer"
          title="See these jobs side by side in the all-jobs view"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          View {count === 1 ? "job" : `${count} jobs`} together
        </button>
      </div>
      {/* Bulk-toggle the Test label on the current selection. */}
      <div className="px-3 pb-2 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          Test label
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => onTag(true)}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
          title="Tag selected jobs as Test"
        >
          <Tag className="h-3 w-3" />
          Tag
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onTag(false)}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
          title="Remove the Test label from selected jobs"
        >
          <X className="h-3 w-3" />
          Untag
        </button>
      </div>
    </div>
  )
}
