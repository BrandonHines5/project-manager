"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutGrid,
  Bell,
  Building2,
  Settings,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { UserRole } from "@/lib/auth"

type Item = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  roles?: UserRole[]
}

const ITEMS: Item[] = [
  { href: "/projects", label: "Projects", icon: LayoutGrid },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/companies", label: "Companies", icon: Building2, roles: ["staff"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["staff"] },
]

export function Sidebar({ role }: { role: UserRole }) {
  const path = usePathname()
  return (
    <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-border bg-[#0d2543] text-white">
      <Link
        href="/projects"
        className="px-5 h-14 flex items-center gap-2 border-b border-white/10"
      >
        <div className="h-8 w-8 rounded-md bg-brand-500 flex items-center justify-center font-bold text-sm">
          HH
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Hines Homes</div>
          <div className="text-[10px] uppercase text-white/60 tracking-wider">
            Project Manager
          </div>
        </div>
      </Link>
      <nav className="flex-1 py-3">
        {ITEMS.filter((i) => !i.roles || i.roles.includes(role)).map((item) => {
          const Icon = item.icon
          const active =
            path === item.href || path.startsWith(`${item.href}/`)
          return (
            <Link
              key={item.href}
              href={item.href}
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
      <div className="p-4 text-[11px] text-white/40 border-t border-white/10">
        v0.1 · BrandonHines5
      </div>
    </aside>
  )
}
