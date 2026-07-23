import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * In-app notification fan-out for a new comment, via the admin client so it
 * works from token/public actions too. The 0036 mute trigger silently drops
 * rows for muted recipients, and the email-digest cron picks the rest up —
 * nothing more to do here. Best-effort: never throws.
 *
 * Direction rules:
 *  - client/trade (or external token-page) author → notify all staff.
 *  - staff author → notify the explicit counterparty profiles the caller
 *    resolved (client project members, the sub's trade profiles, …).
 */
export async function notifyCommentPosted(opts: {
  entityLabel: string // e.g. 'Decision #4 — Flooring', 'Job Log 7/3/2026'
  projectName?: string | null
  authorName: string
  authorIsStaff: boolean
  authorProfileId?: string | null
  body: string
  /** Link used for staff recipients. */
  staffLink: string
  /** Link + recipients used when a staff member authored the comment. */
  counterpartyProfileIds?: string[]
  counterpartyLink?: string | null
  /**
   * The project the commented entity belongs to. REQUIRED so a future caller
   * can't reintroduce an unscoped all-staff fan-out by omission — the staff
   * fan-out is limited to members of the project's organization (the admin
   * client bypasses org RLS). Resolution failure fails CLOSED to nobody.
   * Pass `null` explicitly only for entities with genuinely no project
   * (those notify all staff, the legacy single-tenant behavior).
   */
  projectId: string | null
}): Promise<void> {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return

    let recipientIds: string[]
    let linkUrl: string
    if (opts.authorIsStaff) {
      recipientIds = opts.counterpartyProfileIds ?? []
      linkUrl = opts.counterpartyLink ?? opts.staffLink
    } else if (opts.projectId) {
      const { data: proj } = await admin
        .from("projects")
        .select("org_id")
        .eq("id", opts.projectId)
        .maybeSingle()
      const orgId = proj?.org_id
      if (!orgId) {
        console.warn(
          "[comms] could not resolve the project's org — skipping staff fan-out"
        )
        return
      }
      const { data: staff, error } = await admin
        .from("profiles")
        .select("id, organization_members!inner(org_id)")
        .eq("role", "staff")
        .eq("organization_members.org_id", orgId)
      if (error) {
        console.warn("[comms] staff lookup failed:", error.message)
        return
      }
      recipientIds = (staff ?? []).map((p) => p.id)
      linkUrl = opts.staffLink
    } else {
      const { data: staff, error } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "staff")
      if (error) {
        console.warn("[comms] staff lookup failed:", error.message)
        return
      }
      recipientIds = (staff ?? []).map((p) => p.id)
      linkUrl = opts.staffLink
    }

    recipientIds = recipientIds.filter(
      (id) => id && id !== opts.authorProfileId
    )
    if (!recipientIds.length) return

    const preview =
      opts.body.length > 140 ? `${opts.body.slice(0, 140)}…` : opts.body
    const title = opts.projectName
      ? `${opts.projectName}: comment on ${opts.entityLabel}`
      : `New comment on ${opts.entityLabel}`

    const { error: nErr } = await admin.from("notifications").insert(
      recipientIds.map((id) => ({
        recipient_id: id,
        type: "comment_posted",
        title,
        body: `${opts.authorName}: ${preview}`,
        link_url: linkUrl,
        // Lets the notifications trigger honor per-job mutes (0121).
        project_id: opts.projectId,
      }))
    )
    if (nErr) console.warn("[comms] notification insert failed:", nErr.message)
  } catch (e) {
    console.warn(
      "[comms] notifyCommentPosted exception:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

/**
 * Bell fan-out for an inbound text / call / email captured by a webhook.
 * Goes to all staff (projects.project_manager is a free-text name, not a
 * profile, so there's no reliable per-PM target); matched traffic links to
 * the project's Communications tab, unmatched to the global review queue.
 * Best-effort: never throws.
 */
export async function notifyStaffOfInbound(opts: {
  kind: "sms" | "call" | "email"
  fromName: string
  preview: string
  projectId: string | null
  projectName?: string | null
  /**
   * When set, only staff who are members of this org are notified — so a
   * builder's inbound text never lights up another tenant's bell. Omit (or
   * null) for the legacy single-tenant channels, which notify all staff.
   */
  orgId?: string | null
}): Promise<void> {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return

    const { data: staff } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "staff")
    let recipientIds = (staff ?? []).map((p) => p.id)
    // Multi-tenant scoping: restrict to the org's members when an org is given.
    // Distinguish "not provided" (undefined/null → legacy channels notify all
    // staff) from an explicit empty/blank string (a caller bug) — the latter
    // fails CLOSED to nobody rather than silently notifying every tenant.
    if (opts.orgId !== undefined && opts.orgId !== null) {
      const orgId = opts.orgId.trim()
      if (!orgId) return
      const { data: members } = await admin
        .from("organization_members")
        .select("profile_id")
        .eq("org_id", orgId)
      const memberIds = new Set((members ?? []).map((m) => m.profile_id))
      recipientIds = recipientIds.filter((id) => memberIds.has(id))
    }
    if (!recipientIds.length) return

    const kindLabel =
      opts.kind === "sms" ? "Text" : opts.kind === "call" ? "Call" : "Email"
    const title = opts.projectName
      ? `${opts.projectName}: ${kindLabel.toLowerCase()} from ${opts.fromName}`
      : `${kindLabel} from ${opts.fromName}`
    const preview =
      opts.preview.length > 140 ? `${opts.preview.slice(0, 140)}…` : opts.preview

    const { error } = await admin.from("notifications").insert(
      recipientIds.map((id) => ({
        recipient_id: id,
        type: `inbound_${opts.kind}`,
        title,
        body: preview,
        link_url: opts.projectId
          ? `/projects/${opts.projectId}/communications`
          : "/communications",
        // Lets the notifications trigger honor per-job mutes (0121).
        project_id: opts.projectId ?? null,
      }))
    )
    if (error) console.warn("[comms] inbound notification failed:", error.message)
  } catch (e) {
    console.warn(
      "[comms] notifyStaffOfInbound exception:",
      e instanceof Error ? e.message : String(e)
    )
  }
}
