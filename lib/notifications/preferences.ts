// Notification Settings (item 3) — shared category/channel model + the gate
// used by outbound email/SMS senders.
//
// The in-app channel is gated centrally by the DB trigger
// skip_notification_if_muted (migration 0073); email/SMS have no single choke
// point, so each sender consults isChannelEnabled() before sending.
//
// Absence of a preference row == the channel is ENABLED. Only an explicit
// `enabled = false` row suppresses a channel. So before anyone touches their
// settings, behavior is exactly as it was.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

export const NOTIFICATION_CATEGORIES = [
  {
    key: "assignments",
    label: "Assignments & to-dos",
    description: "When a schedule item or to-do is assigned to you.",
  },
  {
    key: "bids_pos",
    label: "Bids & purchase orders",
    description: "Bid submissions/declines and PO approvals/declines.",
  },
  {
    key: "comments",
    label: "Comments & messages",
    description: "Replies on threads and inbound texts, calls, and emails.",
  },
  {
    key: "client_decisions",
    label: "Client decisions",
    description: "Change orders and selections needing or receiving approval.",
  },
  {
    key: "reminders",
    label: "Reminders",
    description: "Bid reminders and insurance-expiry reminders.",
  },
] as const

export const NOTIFICATION_CHANNELS = [
  { key: "in_app", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["key"]
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]["key"]

// Not every category maps to every channel (companies never get in-app; some
// categories are one-directional). The settings UI uses this to decide which
// cells to render, and it documents which channels each category can control.
export const CHANNELS_BY_CATEGORY: Record<
  NotificationCategory,
  readonly NotificationChannel[]
> = {
  assignments: ["in_app", "email", "sms"],
  bids_pos: ["in_app", "email", "sms"],
  comments: ["in_app", "email"],
  client_decisions: ["in_app", "email"],
  reminders: ["email", "sms"],
}

type AnySupabase = SupabaseClient<Database>

/**
 * Whether a given owner (a profile — team member or client — OR a company)
 * still wants a given category on a given channel. Returns true (enabled)
 * unless an explicit `enabled = false` row exists. Fails open on any error
 * (e.g. the table not existing yet on a preview deploy) so a preference lookup
 * can never silently swallow a real notification.
 */
/**
 * Which of these profiles muted this project (Settings → Notifications, or
 * the bell on the job header). The central notifications-table trigger
 * already drops in-app rows for muted (recipient, project) pairs; this is
 * the app-layer twin for the DIRECT email senders, which send without
 * writing a notifications row. Fails open (empty set) like isChannelEnabled
 * — a lookup error must never swallow real notifications. No project = no
 * mutes apply.
 */
export async function mutedProfileIdsForProject(
  supabase: AnySupabase,
  profileIds: string[],
  projectId: string | null | undefined
): Promise<Set<string>> {
  if (!projectId || profileIds.length === 0) return new Set()
  try {
    const { data, error } = await supabase
      .from("notification_project_mutes")
      .select("profile_id")
      .eq("project_id", projectId)
      .in("profile_id", profileIds)
    if (error) return new Set()
    return new Set((data ?? []).map((m) => m.profile_id))
  } catch {
    return new Set()
  }
}

export async function isChannelEnabled(
  supabase: AnySupabase,
  owner: { profileId?: string | null; companyId?: string | null },
  category: NotificationCategory,
  channel: NotificationChannel
): Promise<boolean> {
  const column = owner.profileId ? "profile_id" : "company_id"
  const value = owner.profileId ?? owner.companyId
  if (!value) return true
  try {
    const { data, error } = await supabase
      .from("notification_preferences")
      .select("enabled")
      .eq(column, value)
      .eq("category", category)
      .eq("channel", channel)
      .maybeSingle()
    if (error) return true
    return data ? data.enabled : true
  } catch {
    return true
  }
}
