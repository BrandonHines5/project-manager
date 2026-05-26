"use client"

import { useState } from "react"
import Link from "next/link"
import { Bell, ChevronDown, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar } from "@/components/ui/avatar"
import { GlobalSearch } from "@/components/layout/global-search"
import { AIAgent } from "@/components/layout/ai-agent"

export function Topbar({
  fullName,
  email,
  role,
  unreadCount,
}: {
  fullName: string
  email: string
  role: string
  unreadCount: number
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="h-14 shrink-0 bg-surface border-b border-border flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2 md:hidden">
        <div className="h-8 w-8 rounded-md bg-brand-500 text-white flex items-center justify-center text-sm font-bold">
          HH
        </div>
        <div className="text-sm font-semibold">Project Manager</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
        <AIAgent />
        <Link
          href="/notifications"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
          )}
        </Link>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md hover:bg-background px-2 py-1 cursor-pointer"
          >
            <Avatar name={fullName || email} size="sm" />
            <div className="hidden sm:block text-left">
              <div className="text-sm font-medium leading-tight">
                {fullName || email}
              </div>
              <div className="text-[11px] text-muted capitalize leading-tight">
                {role}
              </div>
            </div>
            <ChevronDown className="h-4 w-4 text-muted" />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div
                className={cn(
                  "absolute right-0 mt-1 w-56 rounded-md border border-border bg-surface shadow-lg z-50 py-1"
                )}
              >
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm font-medium">{fullName || "—"}</div>
                  <div className="text-xs text-muted">{email}</div>
                </div>
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
