import type { Tables } from "@/lib/db/types"
import { formatDate } from "@/lib/utils"

/**
 * Normalized shape every Communications feed row maps into — five comment
 * tables plus the communications (email/SMS/call) log, merged and sorted.
 * Pure data assembly: no Supabase imports, safe to share between the
 * per-project tab and the global staff hub, and unit-testable.
 */

export type FeedEntityType =
  | "decision"
  | "bid"
  | "po"
  | "schedule_item"
  | "daily_log"

export type FeedAuthorRole = "staff" | "client" | "trade" | "external"

export type FeedItem = {
  /** `${source}:${rowId}` — unique across the merged feed. */
  id: string
  kind: "comment" | "email" | "sms" | "call"
  direction?: "outbound" | "inbound"
  /** Present on comments: what the comment is attached to. */
  entity?: { type: FeedEntityType; id: string; label: string; href: string }
  author: { name: string; role: FeedAuthorRole }
  subject?: string | null
  body: string
  occurredAt: string
  /** Deep link back to the source (empty string = no link). */
  href: string
  projectId: string | null
  callDurationSeconds?: number | null
  callRecordingUrl?: string | null
  /** Inline-reply capability, rendered by the client for staff. */
  reply?:
    | {
        type: "comment"
        entityType: FeedEntityType
        entityId: string
        /** bid replies post to a recipient thread, not the package */
        recipientId?: string
      }
    | { type: "sms"; to: string; companyId: string | null; profileId: string | null }
    | null
}

/** Minimal profile info used to resolve comment author names/roles. */
export type FeedProfile = {
  id: string
  full_name: string | null
  email: string | null
  role: string
}

export type DecisionCommentRow = Tables<"decision_comments"> & {
  decisions: { id: string; project_id: string; number: number; title: string }
}
export type BidCommentRow = Tables<"bid_comments"> & {
  bid_recipients: {
    id: string
    company_id: string
    bid_package_id: string
    companies: { name: string } | null
    bid_packages: { id: string; project_id: string; number: number; title: string }
  }
}
export type PoCommentRow = Tables<"po_comments"> & {
  purchase_orders: {
    id: string
    project_id: string
    number: number
    title: string
    company_id: string | null
    companies: { name: string } | null
  }
}
export type ScheduleCommentRow = Tables<"schedule_item_comments"> & {
  schedule_items: { id: string; project_id: string; title: string }
}
export type DailyLogCommentRow = Tables<"daily_log_comments"> & {
  daily_logs: { id: string; project_id: string; log_date: string }
}

export type FeedSources = {
  decisionComments: DecisionCommentRow[]
  bidComments: BidCommentRow[]
  poComments: PoCommentRow[]
  scheduleComments: ScheduleCommentRow[]
  dailyLogComments: DailyLogCommentRow[]
  communications: Tables<"communications">[]
  /** Authors referenced by the comment rows (admin-resolved, display only). */
  profiles: FeedProfile[]
}

function profileName(p: FeedProfile | undefined, fallback: string): string {
  return p?.full_name || p?.email || fallback
}

function profileRole(p: FeedProfile | undefined, fallback: FeedAuthorRole): FeedAuthorRole {
  if (p?.role === "staff" || p?.role === "client" || p?.role === "trade") {
    return p.role
  }
  return fallback
}

export function buildFeed(sources: FeedSources): FeedItem[] {
  const byId = new Map(sources.profiles.map((p) => [p.id, p]))
  const items: FeedItem[] = []

  for (const c of sources.decisionComments) {
    const author = c.author_id ? byId.get(c.author_id) : undefined
    const projectId = c.decisions.project_id
    const href = `/projects/${projectId}/decisions?open=${c.decisions.id}`
    items.push({
      id: `decision_comment:${c.id}`,
      kind: "comment",
      entity: {
        type: "decision",
        id: c.decisions.id,
        label: `Decision #${c.decisions.number} — ${c.decisions.title}`,
        href,
      },
      author: {
        // Unresolvable author under the viewer's RLS = someone on the
        // project team (staff, or the other client member).
        name: profileName(author, "Project team"),
        role: profileRole(author, "staff"),
      },
      body: c.body,
      occurredAt: c.created_at,
      href,
      projectId,
      reply: { type: "comment", entityType: "decision", entityId: c.decisions.id },
    })
  }

  for (const c of sources.bidComments) {
    const rec = c.bid_recipients
    const author = c.author_profile_id ? byId.get(c.author_profile_id) : undefined
    const projectId = rec.bid_packages.project_id
    const href = `/projects/${projectId}/bids?open=${rec.bid_packages.id}&recipient=${rec.id}`
    items.push({
      id: `bid_comment:${c.id}`,
      kind: "comment",
      entity: {
        type: "bid",
        id: rec.bid_packages.id,
        label: `Bid #${rec.bid_packages.number} — ${rec.bid_packages.title}${
          rec.companies ? ` (${rec.companies.name})` : ""
        }`,
        href,
      },
      author: {
        name: c.author_name,
        // Token-page subs have no profile — treat as the sub company.
        role: profileRole(author, "trade"),
      },
      body: c.body,
      occurredAt: c.created_at,
      href,
      projectId,
      reply: {
        type: "comment",
        entityType: "bid",
        entityId: rec.bid_packages.id,
        recipientId: rec.id,
      },
    })
  }

  for (const c of sources.poComments) {
    const po = c.purchase_orders
    const author = c.author_profile_id ? byId.get(c.author_profile_id) : undefined
    const href = `/projects/${po.project_id}/purchase-orders?open=${po.id}`
    items.push({
      id: `po_comment:${c.id}`,
      kind: "comment",
      entity: {
        type: "po",
        id: po.id,
        label: `PO-${po.number} — ${po.title}${po.companies ? ` (${po.companies.name})` : ""}`,
        href,
      },
      author: { name: c.author_name, role: profileRole(author, "trade") },
      body: c.body,
      occurredAt: c.created_at,
      href,
      projectId: po.project_id,
      reply: { type: "comment", entityType: "po", entityId: po.id },
    })
  }

  for (const c of sources.scheduleComments) {
    const item = c.schedule_items
    const author = c.author_id ? byId.get(c.author_id) : undefined
    const href = `/projects/${item.project_id}/schedule?open=${item.id}`
    items.push({
      id: `schedule_comment:${c.id}`,
      kind: "comment",
      entity: { type: "schedule_item", id: item.id, label: `Schedule: ${item.title}`, href },
      author: { name: c.author_name, role: profileRole(author, "trade") },
      body: c.body,
      occurredAt: c.created_at,
      href,
      projectId: item.project_id,
      reply: { type: "comment", entityType: "schedule_item", entityId: item.id },
    })
  }

  for (const c of sources.dailyLogComments) {
    const log = c.daily_logs
    const author = c.author_id ? byId.get(c.author_id) : undefined
    const href = `/projects/${log.project_id}/daily-logs?open=${log.id}`
    items.push({
      id: `daily_log_comment:${c.id}`,
      kind: "comment",
      entity: {
        type: "daily_log",
        id: log.id,
        label: `Job Log ${formatDate(log.log_date)}`,
        href,
      },
      author: { name: c.author_name, role: profileRole(author, "client") },
      body: c.body,
      occurredAt: c.created_at,
      href,
      projectId: log.project_id,
      reply: { type: "comment", entityType: "daily_log", entityId: log.id },
    })
  }

  for (const m of sources.communications) {
    const sender = m.sent_by ? byId.get(m.sent_by) : undefined
    const isOutbound = m.direction === "outbound"
    const author = isOutbound
      ? {
          name: profileName(sender, "Hines Homes"),
          role: "staff" as FeedAuthorRole,
        }
      : {
          name: m.counterparty_name || m.from_address || "Unknown",
          role: "external" as FeedAuthorRole,
        }
    const smsCounterparty = isOutbound ? m.to_address : m.from_address
    items.push({
      id: `comm:${m.id}`,
      kind: m.channel,
      direction: m.direction,
      author,
      subject: m.subject,
      body: m.body ?? "",
      occurredAt: m.occurred_at,
      href: "",
      projectId: m.project_id,
      callDurationSeconds: m.call_duration_seconds,
      callRecordingUrl: m.call_recording_url,
      reply:
        m.channel === "sms" && smsCounterparty
          ? {
              type: "sms",
              to: smsCounterparty,
              companyId: m.company_id,
              profileId: m.profile_id,
            }
          : null,
    })
  }

  items.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
  return items
}
