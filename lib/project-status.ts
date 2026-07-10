import type { Enums } from "@/lib/db/types"

// Statuses that count as an "open" job. Shared by the jobs-list sidebar's
// default Open filter and the /all/* aggregate pages' default scope so
// "all jobs" means the same thing everywhere. (Statuses mirror the CRM's;
// complete / warranty / cancelled are the closed ones.)
export const OPEN_STATUSES: ReadonlyArray<Enums<"project_status">> = [
  "upcoming",
  "in_work",
  "inventory",
  "paused",
]

// Every project status, in the order filter UIs list them: the live ones
// first (mirroring OPEN_STATUSES), then the closed ones. The enum mirrors
// the Hines Homes CRM's statuses 1:1, so the words themselves are the CRM's.
export const ALL_STATUSES: ReadonlyArray<Enums<"project_status">> = [
  "upcoming",
  "in_work",
  "inventory",
  "paused",
  "warranty",
  "complete",
  "cancelled",
]

// A jobs-list status filter: the Open group (OPEN_STATUSES), one specific
// status, or everything. Shared by the sidebar's filter dropdown and the
// /projects chips so the two filters read the same way.
export type ProjectStatusFilter = "open" | "all" | Enums<"project_status">

export const STATUS_FILTER_LABEL: Record<ProjectStatusFilter, string> = {
  open: "Open",
  all: "All",
  upcoming: "Upcoming",
  in_work: "In Work",
  complete: "Complete",
  warranty: "Warranty",
  inventory: "Inventory",
  paused: "Paused",
  cancelled: "Cancelled",
}

// Type guard for filter state that can also hold non-status values (the
// sidebar and /projects chips both mix these with "label:<name>" strings).
export function isProjectStatusFilter(f: string): f is ProjectStatusFilter {
  return (
    f === "open" ||
    f === "all" ||
    (ALL_STATUSES as ReadonlyArray<string>).includes(f)
  )
}

export function matchesStatusFilter(
  status: Enums<"project_status">,
  filter: ProjectStatusFilter
): boolean {
  if (filter === "all") return true
  if (filter === "open") return OPEN_STATUSES.includes(status)
  return status === filter
}

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
