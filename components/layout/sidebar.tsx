"use client"

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
  ShieldCheck,
  Droplets,
  Gavel,
  FileCheck2,
  FileBadge,
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
// close itself when the user taps an item.
export function SidebarNavList({
  role,
  onNavigate,
}: {
  role: UserRole
  onNavigate?: () => void
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
            className={cn(
              "flex items-center gap-3 mx-2 my-0.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-white/10 text-white"
                : "text-white/70 hover:bg-white/5 hover:text-white"
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function Sidebar({ role, brand }: { role: UserRole; brand?: Brand }) {
  return (
    <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground">
      <SidebarBrand brand={brand} />
      <SidebarNavList role={role} />
      <div className="p-4 text-[11px] text-white/40 border-t border-white/10">
        v0.1 · BrandonHines5
      </div>
    </aside>
  )
}
