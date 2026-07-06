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
}): Promise<void> {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return

    let recipientIds: string[]
    let linkUrl: string
    if (opts.authorIsStaff) {
      recipientIds = opts.counterpartyProfileIds ?? []
      linkUrl = opts.counterpartyLink ?? opts.staffLink
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
