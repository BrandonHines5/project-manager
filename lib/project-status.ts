import type { Enums } from "@/lib/db/types"

// Statuses that count as an "open" job. Shared by the jobs-list sidebar's
// default Open filter and the /all/* aggregate pages' default scope so
// "all jobs" means the same thing everywhere.
export const OPEN_STATUSES: ReadonlyArray<Enums<"project_status">> = [
  "lead",
  "pre_construction",
  "active",
  "on_hold",
]

// Sections that have an "all jobs" aggregate view, keyed by the project
// sub-route slug they correspond to. Used to carry the user's current
// section when they jump between one job and all jobs.
export const AGGREGATE_ROUTE_BY_SLUG: Record<string, string> = {
  schedule: "/all/schedule",
  "daily-logs": "/all/daily-logs",
  decisions: "/all/decisions",
}

export function aggregateRouteForSlug(slug: string | null | undefined): string {
  return (slug && AGGREGATE_ROUTE_BY_SLUG[slug]) || "/all/schedule"
}
