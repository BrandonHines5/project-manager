import type { Enums } from "@/lib/db/types"

// Shared vocabulary for the Hines Homes CRM's project_status. Kept in one place
// so the sync action (app/actions/crm-sync.ts) and the UI agree on the exact
// words, the badge tone, and how each CRM status maps back to PM's own
// project_status enum.
//
// The CRM's `projects.project_status` is free-text; today it holds one of:
//   In Work · Upcoming · Inventory · Paused · Warranty · Complete · Cancelled
// We display it verbatim, but PM's internal logic (warranty page, portfolio
// health, the sidebar's Open/Active/Warranty/Closed filter) still runs off the
// `status` enum — so the sync maps CRM → enum with this table.

export type BadgeTone =
  | "brand"
  | "muted"
  | "warning"
  | "success"
  | "danger"
  | "info"

// CRM status word -> local project_status enum. Anything not listed here (a new
// CRM status we haven't mapped) leaves the enum untouched during a sync, while
// still being stored + displayed verbatim in crm_status.
export const CRM_STATUS_TO_ENUM: Record<string, Enums<"project_status">> = {
  "In Work": "active",
  Upcoming: "pre_construction",
  Inventory: "active",
  Paused: "on_hold",
  Warranty: "warranty",
  Complete: "complete",
  Cancelled: "cancelled",
}

/**
 * Maps a verbatim CRM status to PM's project_status enum, or null when the CRM
 * status isn't one we recognise (so callers can skip touching the enum).
 * Case-insensitive on the CRM side to tolerate minor casing drift.
 */
export function crmStatusToEnum(
  crmStatus: string | null | undefined
): Enums<"project_status"> | null {
  if (!crmStatus) return null
  const trimmed = crmStatus.trim()
  if (trimmed in CRM_STATUS_TO_ENUM) return CRM_STATUS_TO_ENUM[trimmed]
  const hit = Object.keys(CRM_STATUS_TO_ENUM).find(
    (k) => k.toLowerCase() === trimmed.toLowerCase()
  )
  return hit ? CRM_STATUS_TO_ENUM[hit] : null
}

/**
 * Badge tone for a verbatim CRM status word. Unknown values fall back to a
 * neutral tone so an unexpected status still renders a readable badge.
 */
export function crmStatusTone(crmStatus: string): BadgeTone {
  switch (crmStatus.trim().toLowerCase()) {
    case "in work":
      return "brand"
    case "upcoming":
    case "inventory":
    case "warranty":
      return "info"
    case "paused":
      return "warning"
    case "complete":
      return "success"
    case "cancelled":
      return "danger"
    default:
      return "muted"
  }
}
