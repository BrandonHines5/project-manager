import type { Tables } from "@/lib/db/types"
import type { BadgeProps } from "@/components/ui/badge"

// Shared constants + helpers for the Feedback & Requests module. Lives outside
// the "use server" action file (which may only export async functions) so both
// server actions and client components can import these.

export type FeedbackRow = Tables<"feedback_requests">

export const FEEDBACK_TYPES = [
  "Feature Request",
  "Bug Report",
  "Update Request",
  "Question",
] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

// New → In Review → In Progress → Complete | Declined
export const FEEDBACK_STATUSES = [
  "New",
  "In Review",
  "In Progress",
  "Complete",
  "Declined",
] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

type Tone = NonNullable<BadgeProps["tone"]>

export const TYPE_TONE: Record<FeedbackType, Tone> = {
  "Feature Request": "brand",
  "Bug Report": "danger",
  "Update Request": "info",
  Question: "muted",
}

export const STATUS_TONE: Record<FeedbackStatus, Tone> = {
  New: "danger",
  "In Review": "warning",
  "In Progress": "info",
  Complete: "success",
  Declined: "muted",
}

// A request "has a response" once staff have moved it off New or left a note —
// that's the signal the submitter has something new to look at.
export function hasResponse(row: Pick<FeedbackRow, "status" | "admin_notes">) {
  return row.status !== "New" || !!(row.admin_notes && row.admin_notes.trim())
}

// Compact signature used to detect when a request the submitter already saw has
// since changed (status flip or edited admin note).
export function responseSignature(
  row: Pick<FeedbackRow, "status" | "admin_notes">
) {
  return `${row.status}|${row.admin_notes ?? ""}`
}
