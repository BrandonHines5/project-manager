"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

/**
 * Renders the jobs list alongside `children`. Buildertrend-style: the list is
 * there on (almost) every page so the user can always jump between jobs or
 * build a selection — it's collapsible when they want the room back. The
 * sidebar JSX is passed in as a prop so the parent (a server component) keeps
 * doing the database fetch; this client component only owns the route gate.
 *
 * The only exceptions: the Projects index (its table IS the project list —
 * repeating it in a sidebar would show every job twice) and the new-job form.
 */
const SIDEBAR_HIDDEN_EXACT = ["/projects", "/projects/new"]

export function ProjectContextShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  const pathname = usePathname()
  const showSidebar = !SIDEBAR_HIDDEN_EXACT.includes(pathname)
  // min-h-0 lets this row shrink inside the viewport-height shell so the
  // jobs list and the page content each scroll on their own.
  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {showSidebar && sidebar}
      <div className="flex-1 min-w-0 flex flex-col">{children}</div>
    </div>
  )
}
