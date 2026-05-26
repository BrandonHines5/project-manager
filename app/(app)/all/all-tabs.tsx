"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { Calendar, ClipboardList, ScrollText } from "lucide-react"
import { cn } from "@/lib/utils"

const TABS = [
  { slug: "schedule", label: "Schedule", icon: Calendar },
  { slug: "daily-logs", label: "Daily Logs", icon: ScrollText },
  { slug: "decisions", label: "Decisions", icon: ClipboardList },
] as const

export function AllTabs() {
  const path = usePathname()
  // Carry the selection through tab clicks so the user doesn't lose it when
  // they switch between Schedule / Daily Logs / Decisions.
  const ids = useSearchParams().get("ids") ?? ""
  return (
    <nav className="flex gap-1 border-b border-border mb-5">
      {TABS.map((t) => {
        const Icon = t.icon
        const href = ids ? `/all/${t.slug}?ids=${ids}` : `/all/${t.slug}`
        const active = path === `/all/${t.slug}`
        return (
          <Link
            key={t.slug}
            href={href}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 inline-flex items-center gap-1.5 transition-colors",
              active
                ? "border-brand-500 text-brand-700"
                : "border-transparent text-muted hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
