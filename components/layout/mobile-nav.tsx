"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { SidebarBrand, SidebarNavList } from "@/components/layout/sidebar"
import type { SidebarProject } from "@/components/layout/project-list-sidebar"
import { matchesStatusFilter } from "@/lib/project-status"
import type { UserRole } from "@/lib/auth"
import { HINES_HOMES, type Brand } from "@/lib/brand"

/**
 * Hamburger button + slide-in drawer that exposes the main nav on mobile.
 * The desktop jobs-list sidebar is hidden below the `lg` breakpoint; this
 * fills that gap, so it shows everywhere below `lg` (phones AND portrait
 * tablets — previously it cut off at `md`, leaving 768–1023px with neither).
 *
 * Besides the flat nav list, the drawer carries a compact job switcher —
 * the only way to jump between jobs on a phone without a round-trip through
 * the /projects index.
 *
 * Nav items and the brand link both call `setOpen(false)` directly via
 * their onNavigate prop, so the drawer closes itself when the user taps
 * anywhere that triggers navigation.
 */
export function MobileNav({
  role,
  brand = HINES_HOMES,
  projects = [],
}: {
  role: UserRole
  brand?: Brand
  projects?: SidebarProject[]
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  // Lock body scroll while the drawer is open so the page behind doesn't
  // pan around under the user's finger.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Backdrop */}
      <div
        onClick={close}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-xl",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          "transform transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="relative shrink-0">
          <SidebarBrand onNavigate={close} brand={brand} />
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* The nav keeps its natural height (scrolling internally past 45% of
            the screen on short phones) so the job switcher below always gets
            meaningful room. */}
        <SidebarNavList
          role={role}
          onNavigate={close}
          className={cn(projects.length > 0 && "flex-none max-h-[45dvh]")}
        />
        {projects.length > 0 && (
          <MobileJobList projects={projects} onNavigate={close} />
        )}
        <div className="p-4 shrink-0 text-[11px] text-white/40 border-t border-white/10">
          v0.1 · BrandonHines5
        </div>
      </aside>
    </div>
  )
}

/**
 * Compact job switcher for the drawer. Shows open jobs by default; typing in
 * the search reaches every job regardless of status (mirroring how the
 * desktop jobs list is used: recent work up front, search for the rest).
 * Templates never show — duplicating from a template is a desktop flow.
 */
function MobileJobList({
  projects,
  onNavigate,
}: {
  projects: SidebarProject[]
  onNavigate: () => void
}) {
  const pathname = usePathname()
  const [query, setQuery] = useState("")

  // Keep the user's current section when switching jobs (schedule → schedule,
  // job logs → job logs), same as the desktop jobs list. Anywhere without a
  // section in the URL falls back to the job's default page.
  const currentSubRoute = useMemo(() => {
    const m = pathname.match(/^\/projects\/[^/]+\/([^/]+)/)
    const all = pathname.match(/^\/all\/([^/]+)/)
    return m?.[1] ?? all?.[1] ?? null
  }, [pathname])
  const currentProjectId = useMemo(
    () => pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null,
    [pathname]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      if (p.project_number.toUpperCase().startsWith("TEMPLATE")) return false
      if (!q) return matchesStatusFilter(p.status, "open")
      return (
        p.name.toLowerCase().includes(q) ||
        p.project_number.toLowerCase().includes(q) ||
        (p.address?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [projects, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-white/10">
      <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-white/50">
        Jobs
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all jobs"
            className="h-9 w-full rounded-md border border-white/15 bg-white/10 pl-8 pr-2 text-sm text-white placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          />
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {filtered.length === 0 ? (
          <li className="px-4 py-4 text-center text-xs text-white/40">
            No jobs match.
          </li>
        ) : (
          filtered.map((p) => (
            <li key={p.id}>
              <Link
                href={
                  currentSubRoute
                    ? `/projects/${p.id}/${currentSubRoute}`
                    : `/projects/${p.id}`
                }
                onClick={onNavigate}
                className={cn(
                  "mx-2 my-0.5 flex items-baseline gap-2 rounded-md px-3 py-2 text-sm",
                  p.id === currentProjectId
                    ? "bg-white/10 text-white"
                    : "text-white/70 hover:bg-white/5 hover:text-white"
                )}
              >
                <span className="shrink-0 font-mono text-[11px] text-white/40">
                  {p.project_number}
                </span>
                <span className="truncate">{p.name}</span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
