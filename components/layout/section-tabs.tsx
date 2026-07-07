"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { LayoutGrid } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UserRole } from "@/lib/auth"
import { AGGREGATE_ROUTE_BY_SLUG } from "@/lib/project-status"

type Section = {
  label: string
  // Project sub-route: /projects/{id}/{slug}
  slug: string
  hideForRoles?: UserRole[]
  // Where this section lives in all-jobs scope. Sections without one are
  // per-job only and disappear when no job is selected.
  aggregateHref?: string
  // Extra gate for the aggregate link (e.g. /communications is staff-only).
  aggregateRoles?: UserRole[]
}

const SECTIONS: Section[] = [
  {
    label: "Schedule",
    slug: "schedule",
    hideForRoles: ["client"],
    aggregateHref: AGGREGATE_ROUTE_BY_SLUG["schedule"],
  },
  { label: "Onsite", slug: "onsite", hideForRoles: ["client", "trade"] },
  {
    label: "Job Logs",
    slug: "daily-logs",
    aggregateHref: AGGREGATE_ROUTE_BY_SLUG["daily-logs"],
  },
  {
    label: "Decisions",
    slug: "decisions",
    aggregateHref: AGGREGATE_ROUTE_BY_SLUG["decisions"],
  },
  { label: "Bids", slug: "bids", hideForRoles: ["client", "trade"] },
  { label: "POs", slug: "purchase-orders", hideForRoles: ["client", "trade"] },
  // Visible to every role on a job — RLS filters the feed to each viewer's
  // own conversations. The global hub, though, is a staff page.
  {
    label: "Communications",
    slug: "communications",
    aggregateHref: "/communications",
    aggregateRoles: ["staff"],
  },
  { label: "Files", slug: "files" },
  { label: "Pricing", slug: "pricing" },
  { label: "Roles", slug: "roles", hideForRoles: ["client", "trade"] },
]

/**
 * Buildertrend-style section bar that sits directly under the topbar on every
 * job-context page. Two scopes:
 *
 * - Job scope (/projects/{id}/…): tabs switch sections within that job; the
 *   leading "All jobs" chip jumps to the same section across all jobs.
 * - All-jobs scope (/projects index, /all/*, /communications): only sections
 *   with an aggregate view show, and they span every open job by default
 *   (or the ?ids= selection carried from the jobs list).
 */
export function SectionTabs({ role }: { role: UserRole }) {
  const path = usePathname()
  // Carry the jobs-list selection between aggregate tabs so switching from
  // Schedule to Job Logs keeps the same set of jobs in view.
  const ids = useSearchParams().get("ids") ?? ""

  const m = path.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/)
  const projectId = m && m[1] !== "new" ? m[1] : null
  const projectSlug = m?.[2] ?? null

  const onProjectsIndex = path === "/projects"
  const onAll = path === "/all" || path.startsWith("/all/")
  const onComms =
    path === "/communications" || path.startsWith("/communications/")
  const inAllScope = onProjectsIndex || onAll || onComms

  if (!projectId && !inAllScope) return null

  const visible = SECTIONS.filter((s) => !s.hideForRoles?.includes(role))
  const aggregateTabs = visible.filter(
    (s) =>
      s.aggregateHref && (!s.aggregateRoles || s.aggregateRoles.includes(role))
  )
  const tabs = projectId ? visible : aggregateTabs

  const withIds = (href: string) =>
    ids && href.startsWith("/all/") ? `${href}?ids=${ids}` : href

  // Where the "All jobs" chip lands from a job page: the same section when
  // it has an aggregate view the viewer may see, else the viewer's first
  // aggregate section (clients, e.g., have no Schedule).
  const chipHref = withIds(
    aggregateTabs.find((s) => s.slug === projectSlug)?.aggregateHref ??
      aggregateTabs[0]?.aggregateHref ??
      "/all/schedule"
  )

  return (
    <div className="shrink-0 bg-surface border-b border-border">
      <nav
        aria-label="Job sections"
        className="flex items-center gap-1 px-3 md:px-4 overflow-x-auto"
      >
        {inAllScope ? (
          <span className="mr-1 my-1.5 shrink-0 inline-flex items-center gap-1.5 rounded-full bg-brand-500 text-white px-3 py-1 text-xs font-medium">
            <LayoutGrid className="h-3.5 w-3.5" />
            All jobs
          </span>
        ) : (
          <Link
            href={chipHref}
            title="View this section across all jobs"
            className="mr-1 my-1.5 shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:text-foreground hover:border-border-strong"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            All jobs
          </Link>
        )}
        <div className="h-5 w-px bg-border mx-1 shrink-0" aria-hidden="true" />
        {tabs.map((t) => {
          const href = projectId
            ? `/projects/${projectId}/${t.slug}`
            : withIds(t.aggregateHref!)
          const activePath = projectId
            ? `/projects/${projectId}/${t.slug}`
            : t.aggregateHref!
          const active =
            path === activePath || path.startsWith(`${activePath}/`)
          return (
            <Link
              key={t.slug}
              href={href}
              className={cn(
                "px-3 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                active
                  ? "border-brand-500 text-brand-700"
                  : "border-transparent text-muted hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
