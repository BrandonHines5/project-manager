"use client"

import { useEffect, useState } from "react"
import { Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { SidebarBrand, SidebarNavList } from "@/components/layout/sidebar"
import type { UserRole } from "@/lib/auth"
import { HINES_HOMES, type Brand } from "@/lib/brand"

/**
 * Hamburger button + slide-in drawer that exposes the main nav on mobile.
 * The desktop sidebar in `Sidebar` is hidden below the `md` breakpoint;
 * this fills that gap. Visible only below `md` — at desktop sizes the
 * regular sidebar takes over and this whole component renders nothing
 * (the `md:hidden` outer wrapper).
 *
 * Nav items and the brand link both call `setOpen(false)` directly via
 * their onNavigate prop, so the drawer closes itself when the user taps
 * anywhere that triggers navigation.
 */
export function MobileNav({
  role,
  brand = HINES_HOMES,
}: {
  role: UserRole
  brand?: Brand
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
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground cursor-pointer"
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
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar text-sidebar-foreground shadow-xl",
          "transform transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="relative">
          <SidebarBrand onNavigate={close} brand={brand} />
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <SidebarNavList role={role} onNavigate={close} />
        <div className="p-4 text-[11px] text-white/40 border-t border-white/10">
          v0.1 · BrandonHines5
        </div>
      </aside>
    </div>
  )
}
