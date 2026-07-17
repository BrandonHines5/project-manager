"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Bell,
  ChevronDown,
  Clock,
  LogOut,
  MessageSquarePlus,
  Plug,
  Settings,
  Tags,
  Wallet,
} from "lucide-react"
import dynamic from "next/dynamic"
import { cn } from "@/lib/utils"
import { Avatar } from "@/components/ui/avatar"
import { GlobalSearch } from "@/components/layout/global-search"
import { FeedbackButton } from "@/components/feedback/feedback-button"
import { MobileNav } from "@/components/layout/mobile-nav"
import { BrandTile } from "@/components/layout/brand-tile"
import type { SidebarProject } from "@/components/layout/project-list-sidebar"
import type { UserRole } from "@/lib/auth"
import { HINES_HOMES, type Brand } from "@/lib/brand"

// AIAgent bundles the smart-update chat, its ~450-LOC plan-review UI, and the
// Web-Speech shims — all of it only ever mounts behind the trigger button. Code-
// split it out of the shared client bundle so it doesn't ship in first-load JS on
// every authed page; ssr:false + a same-size placeholder avoids any layout shift
// while the chunk loads on first open.
const AIAgent = dynamic(
  () => import("@/components/layout/ai-agent").then((m) => m.AIAgent),
  { ssr: false, loading: () => <span className="h-9 w-9 shrink-0" aria-hidden /> }
)

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
        label: "People",
        items: [
          { href: "/companies", label: "Companies" },
          { href: "/clients", label: "Clients" },
          { href: "/team", label: "Team" },
        ],
      },
      {
        label: "Operations",
        items: [
          { href: "/companies/insurance", label: "Insurance" },
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
  projects = [],
}: {
  fullName: string
  email: string
  role: UserRole
  unreadCount: number
  brand?: Brand
  projects?: SidebarProject[]
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    // min-h + safe-area padding (instead of a fixed h-14) so the dark bar
    // extends up under the iPhone status bar in home-screen mode without
    // the notch overlapping the controls.
    <header className="min-h-14 pt-[env(safe-area-inset-top)] shrink-0 bg-sidebar text-sidebar-foreground flex items-center gap-2 px-3 md:px-4">
      <MobileNav role={role} brand={brand} projects={projects} />
      <Link
        href="/projects"
        className="flex items-center gap-2 shrink-0 md:mr-3"
      >
        <BrandTile brand={brand} className="h-8 w-8 rounded-md" imgClassName="h-6 w-6" />
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
              <div className="text-[11px] text-white/60 leading-tight">
                {role === "staff" ? "Team" : role === "trade" ? "Sub" : "Client"}
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
                  href="/settings/notifications"
                  onClick={() => setMenuOpen(false)}
                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                >
                  <Settings className="h-4 w-4 text-muted" />
                  Notification settings
                </Link>
                {role === "staff" && (
                  <Link
                    href="/settings/template-tags"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                  >
                    <Tags className="h-4 w-4 text-muted" />
                    Template tags
                  </Link>
                )}
                {role === "staff" && (
                  <Link
                    href="/settings/delay-reasons"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                  >
                    <Clock className="h-4 w-4 text-muted" />
                    Delay reasons
                  </Link>
                )}
                {role === "staff" && (
                  <Link
                    href="/settings/quickbooks"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                  >
                    <Plug className="h-4 w-4 text-muted" />
                    QuickBooks
                  </Link>
                )}
                {role === "staff" && (
                  <Link
                    href="/settings/budget"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-background cursor-pointer"
                  >
                    <Wallet className="h-4 w-4 text-muted" />
                    Budget editors
                  </Link>
                )}
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
