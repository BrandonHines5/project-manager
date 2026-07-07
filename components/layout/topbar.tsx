"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Bell,
  ChevronDown,
  LogOut,
  MessageSquarePlus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar } from "@/components/ui/avatar"
import { GlobalSearch } from "@/components/layout/global-search"
import { AIAgent } from "@/components/layout/ai-agent"
import { FeedbackButton } from "@/components/feedback/feedback-button"
import { MobileNav } from "@/components/layout/mobile-nav"
import type { UserRole } from "@/lib/auth"
import { HINES_HOMES, type Brand } from "@/lib/brand"

// Buildertrend-style primary nav: everything that used to live in the dark
// left sidebar now sits across the top, grouped into dropdowns. The jobs list
// owns the left side of the screen instead. Communications lives in the
// section tabs and Notifications in the bell icon, so neither repeats here.
type MenuLink = { href: string; label: string }
type MenuEntry =
  | { label: string; href: string; items?: undefined }
  | { label: string; items: MenuLink[]; href?: undefined }

function menusFor(role: UserRole): MenuEntry[] {
  if (role === "staff") {
    return [
      { label: "Projects", href: "/projects" },
      {
        label: "Companies",
        items: [
          { href: "/companies", label: "Companies" },
          { href: "/companies/insurance", label: "Insurance" },
          { href: "/team", label: "Team" },
        ],
      },
      {
        label: "Operations",
        items: [
          { href: "/warranty", label: "Warranty / Rental" },
          { href: "/utilities", label: "Initiate Utilities" },
        ],
      },
      { label: "Reports", href: "/reports" },
    ]
  }
  if (role === "trade") {
    return [
      { label: "My assignments", href: "/my-assignments" },
      { label: "My bids", href: "/my-bids" },
      { label: "Purchase orders", href: "/my-pos" },
      { label: "Projects", href: "/projects" },
    ]
  }
  // Clients: the jobs list + section tabs carry everything else.
  return [{ label: "Projects", href: "/projects" }]
}

export function Topbar({
  fullName,
  email,
  role,
  unreadCount,
  brand = HINES_HOMES,
}: {
  fullName: string
  email: string
  role: UserRole
  unreadCount: number
  brand?: Brand
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="h-14 shrink-0 bg-sidebar text-sidebar-foreground flex items-center gap-2 px-3 md:px-4">
      <MobileNav role={role} brand={brand} />
      <Link
        href="/projects"
        className="flex items-center gap-2 shrink-0 md:mr-3"
      >
        <div className="h-8 w-8 rounded-md bg-brand-500 text-white flex items-center justify-center text-sm font-bold">
          {/* Static SVG mark from /public — next/image adds no benefit for SVGs. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={brand.mark} alt={brand.name} className="h-6 w-6" />
        </div>
        {/* Brand text yields to the menus below lg; the mark alone carries
            the brand at tablet widths. */}
        <div className="hidden lg:block leading-tight">
          <div className="text-sm font-semibold">{brand.name}</div>
          <div className="text-[10px] uppercase text-white/60 tracking-wider">
            Project Manager
          </div>
        </div>
      </Link>

      <TopNavMenus role={role} />

      {/* min-w-0 lets the search pill (the only shrinkable item) absorb any
          squeeze instead of the bar overflowing. */}
      <div className="ml-auto flex items-center gap-1.5 min-w-0">
        <GlobalSearch dark />
        <FeedbackButton dark />
        <AIAgent dark />
        <Link
          href="/notifications"
          className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-sidebar" />
          )}
        </Link>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md hover:bg-white/10 px-2 py-1 cursor-pointer"
          >
            <Avatar name={fullName || email} size="sm" />
            <div className="hidden lg:block text-left">
              <div className="text-sm font-medium leading-tight text-white">
                {fullName || email}
              </div>
              <div className="text-[11px] text-white/60 capitalize leading-tight">
                {role}
              </div>
            </div>
            <ChevronDown className="h-4 w-4 text-white/60" />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div
                className={cn(
                  "absolute right-0 mt-1 w-56 rounded-md border border-border bg-surface text-foreground shadow-lg z-50 py-1"
                )}
              >
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm font-medium">{fullName || "—"}</div>
                  <div className="text-xs text-muted">{email}</div>
                </div>
                <Link
                  href="/feedback"
                  onClick={() => setMenuOpen(false)}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                >
                  <MessageSquarePlus className="h-4 w-4 text-muted" />
                  Feedback & requests
                </Link>
                <form action="/auth/signout" method="post">
                  <button
                    type="submit"
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                  >
                    <LogOut className="h-4 w-4 text-muted" />
                    Sign out
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

/**
 * The grouped dropdown menus in the dark top bar (desktop only — the mobile
 * drawer keeps the flat list). Click-to-open with an outside-click overlay;
 * a group lights up when the current route lives inside it.
 */
function TopNavMenus({ role }: { role: UserRole }) {
  const path = usePathname()
  const [openLabel, setOpenLabel] = useState<string | null>(null)
  const menus = menusFor(role)

  const matches = (href: string) => path === href || path.startsWith(`${href}/`)
  // Longest-prefix match across every destination so /companies/insurance
  // lights up only via its own entry, not the /companies one too.
  const allHrefs = menus.flatMap((m) =>
    m.items ? m.items.map((i) => i.href) : [m.href]
  )
  const activeHref = allHrefs
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0]

  return (
    <nav
      aria-label="Main menu"
      className="hidden md:flex items-center gap-0.5 shrink-0"
    >
      {menus.map((m) => {
        const active = m.items
          ? m.items.some((i) => i.href === activeHref)
          : m.href === activeHref
        const itemClass = cn(
          "inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm font-medium whitespace-nowrap cursor-pointer",
          active
            ? "bg-white/10 text-white"
            : "text-white/70 hover:bg-white/5 hover:text-white"
        )
        if (!m.items) {
          return (
            <Link key={m.label} href={m.href} className={itemClass}>
              {m.label}
            </Link>
          )
        }
        const open = openLabel === m.label
        return (
          <div key={m.label} className="relative">
            <button
              type="button"
              onClick={() => setOpenLabel(open ? null : m.label)}
              aria-expanded={open}
              className={itemClass}
            >
              {m.label}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  open && "rotate-180"
                )}
              />
            </button>
            {open && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setOpenLabel(null)}
                />
                <div className="absolute left-0 top-10 z-50 w-52 rounded-md border border-border bg-surface text-foreground shadow-lg py-1">
                  {m.items.map((i) => (
                    <Link
                      key={i.href}
                      href={i.href}
                      onClick={() => setOpenLabel(null)}
                      className={cn(
                        "block px-3 py-2 text-sm hover:bg-background",
                        i.href === activeHref &&
                          "font-medium text-brand-700"
                      )}
                    >
                      {i.label}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
    </nav>
  )
}
