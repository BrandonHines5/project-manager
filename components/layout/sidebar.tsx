"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutGrid,
  Bell,
  Building2,
  BarChart3,
  Users,
  Hammer,
  MessageSquarePlus,
  MessagesSquare,
  ShieldCheck,
  Droplets,
  Gavel,
  FileCheck2,
  FileBadge,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { UserRole } from "@/lib/auth"
import { HINES_HOMES, type Brand } from "@/lib/brand"

type Item = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  roles?: UserRole[]
}

const ITEMS: Item[] = [
  { href: "/my-assignments", label: "My assignments", icon: Hammer, roles: ["trade"] },
  { href: "/my-bids", label: "My bids", icon: Gavel, roles: ["trade"] },
  { href: "/my-pos", label: "Purchase orders", icon: FileCheck2, roles: ["trade"] },
  { href: "/projects", label: "Projects", icon: LayoutGrid },
  {
    href: "/communications",
    label: "Communications",
    icon: MessagesSquare,
    roles: ["staff"],
  },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/companies", label: "Companies", icon: Building2, roles: ["staff"] },
  {
    href: "/companies/insurance",
    label: "Insurance",
    icon: FileBadge,
    roles: ["staff"],
  },
  { href: "/team", label: "Team", icon: Users, roles: ["staff"] },
  {
    href: "/warranty",
    label: "Warranty / Rental",
    icon: ShieldCheck,
    roles: ["staff"],
  },
  {
    href: "/utilities",
    label: "Initiate Utilities",
    icon: Droplets,
    roles: ["staff"],
  },
  { href: "/reports", label: "Reports", icon: BarChart3, roles: ["staff"] },
  { href: "/feedback", label: "Feedback", icon: MessageSquarePlus },
]

// Visible nav items for a role. Exported so MobileNav can reuse the same list.
export function navItemsFor(role: UserRole): Item[] {
  return ITEMS.filter((i) => !i.roles || i.roles.includes(role))
}

// Shared header chunk (HH logo + product name). Used by both desktop sidebar
// and the mobile drawer. `onNavigate` lets the drawer dismiss itself when
// the user taps the logo to head back to /projects.
export function SidebarBrand({
  onNavigate,
  brand = HINES_HOMES,
}: {
  onNavigate?: () => void
  brand?: Brand
}) {
  return (
    <Link
      href="/projects"
      onClick={onNavigate}
      className="px-5 h-14 flex items-center gap-2 border-b border-white/10"
    >
      <div className="h-8 w-8 rounded-md bg-brand-500 text-white flex items-center justify-center font-bold text-sm">
        {/* Static SVG mark from /public — next/image adds no benefit for SVGs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.mark} alt={brand.name} className="h-6 w-6" />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">{brand.name}</div>
        <div className="text-[10px] uppercase text-white/60 tracking-wider">
          Project Manager
        </div>
      </div>
    </Link>
  )
}

// Shared nav list. `onNavigate` is optional — the mobile drawer uses it to
// close itself when the user taps an item. `collapsed` renders icon-only
// entries for the desktop rail; the drawer never collapses.
export function SidebarNavList({
  role,
  onNavigate,
  collapsed = false,
}: {
  role: UserRole
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const path = usePathname()
  const items = navItemsFor(role)
  // Longest-prefix match wins so nested entries (/companies/insurance)
  // don't light up their parent (/companies) at the same time.
  const matches = (href: string) => path === href || path.startsWith(`${href}/`)
  const activeHref = items
    .filter((i) => matches(i.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href
  return (
    <nav className="flex-1 py-3">
      {items.map((item) => {
        const Icon = item.icon
        const active = item.href === activeHref
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={cn(
              "flex items-center gap-3 mx-2 my-0.5 rounded-md px-3 py-2 text-sm transition-colors",
              collapsed && "justify-center px-0",
              active
                ? "bg-white/10 text-white"
                : "text-white/70 hover:bg-white/5 hover:text-white"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}

const COLLAPSE_KEY = "hh.navCollapsed.v1"

export function Sidebar({ role, brand }: { role: UserRole; brand?: Brand }) {
  // Collapsed = icon-only rail so page content gets (nearly) the full width.
  // SSR renders expanded; the stored preference applies after hydration —
  // same pattern as the jobs-list selection.
  const [collapsed, setCollapsed] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect --
     One-time hydration of a persisted UI preference on mount, keeping the
     SSR markup deterministic. */
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1")
    } catch {
      // localStorage unavailable — stay expanded.
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggle() {
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

  const b = brand ?? HINES_HOMES
  return (
    <aside
      className={cn(
        "hidden md:flex md:flex-col shrink-0 border-r border-border bg-sidebar text-sidebar-foreground",
        collapsed ? "w-14" : "w-56"
      )}
    >
      {collapsed ? (
        <Link
          href="/projects"
          title={b.name}
          className="h-14 flex items-center justify-center border-b border-white/10"
        >
          <div className="h-8 w-8 rounded-md bg-brand-500 text-white flex items-center justify-center">
            {/* Static SVG mark from /public — next/image adds no benefit for SVGs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.mark} alt={b.name} className="h-6 w-6" />
          </div>
        </Link>
      ) : (
        <SidebarBrand brand={brand} />
      )}
      <SidebarNavList role={role} collapsed={collapsed} />
      <div
        className={cn(
          "border-t border-white/10 flex items-center",
          collapsed ? "justify-center p-2" : "justify-between p-2 pl-4"
        )}
      >
        {!collapsed && (
          <span className="text-[11px] text-white/40">v0.1 · BrandonHines5</span>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  )
}
