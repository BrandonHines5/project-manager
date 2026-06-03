"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import type { UserRole } from "@/lib/auth"

type Tab = {
  label: string
  slug: string
  hideForRoles?: UserRole[]
}

const TABS: Tab[] = [
  { label: "Schedule", slug: "schedule", hideForRoles: ["client"] },
  { label: "Onsite", slug: "onsite", hideForRoles: ["client", "trade"] },
  { label: "Job Logs", slug: "daily-logs" },
  { label: "Decisions", slug: "decisions" },
  { label: "Files", slug: "files" },
  { label: "Pricing", slug: "pricing" },
]
// Trades only see Schedule (RLS handles row-level filtering); clients only see Job Logs / Files / Pricing.

export function ProjectTabs({
  projectId,
  role,
}: {
  projectId: string
  role: UserRole
}) {
  const path = usePathname()
  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6">
      <nav className="flex gap-1 overflow-x-auto -mb-px">
        {TABS.filter((t) => !t.hideForRoles?.includes(role)).map((t) => {
          const href = `/projects/${projectId}/${t.slug}`
          const active = path === href || path.startsWith(`${href}/`)
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
