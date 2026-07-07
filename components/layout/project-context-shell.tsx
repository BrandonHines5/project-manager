"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

/**
 * Renders the project list sidebar alongside `children` when the user is on a
 * project-context route, and just `children` otherwise. The sidebar JSX is
 * passed in as a prop so the parent (a server component) can keep doing the
 * database fetch — this client component only owns the route-based gate.
 */
const PROJECT_CONTEXT_PREFIXES = ["/projects", "/all"]

// The Projects index IS the project list — repeating it in a sidebar would
// show every job twice. The new-job form doesn't need it either.
const SIDEBAR_HIDDEN_EXACT = ["/projects", "/projects/new"]

export function ProjectContextShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  const pathname = usePathname()
  const showSidebar =
    PROJECT_CONTEXT_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    ) && !SIDEBAR_HIDDEN_EXACT.includes(pathname)
  if (!showSidebar) {
    return <div className="flex-1 min-w-0">{children}</div>
  }
  return (
    <div className="flex flex-1 min-w-0">
      {sidebar}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
