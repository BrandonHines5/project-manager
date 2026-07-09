import { Resend } from "resend"
import { logCommunication, type CommLogContext } from "@/lib/comms/log"
import { graphConfigured, sendGraphMail } from "@/lib/comms/graph"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * Sends a transactional email. Two transports, tried in order:
 *
 *  1. Microsoft Graph — when the MS_* env vars are set and a sender mailbox
 *     resolves (the acting staff user's own address via `log.sent_by`, or
 *     MS_SYSTEM_MAILBOX for cron/system mail). The email goes out from the
 *     user's REAL mailbox, lands in their Sent Items, and replies come back
 *     to their inbox — where the Outlook sync cron picks both up. Logged
 *     with the message's internetMessageId so the sync dedups onto the same
 *     row instead of double-posting the feed.
 *
 *  2. Resend — fallback when Graph is unset/unavailable or a send fails.
 *     Project-scoped Resend sends default their Reply-To to the comms
 *     plus-tag inbox so replies are still captured.
 *
 * Graceful no-op when neither transport is configured, so dev/preview
 * environments never break.
 */
export async function sendEmail(opts: {
  to: string | string[]
  cc?: string | string[]
  // Optional Reply-To. When the recipient hits "Reply" their response goes here
  // instead of the (often send-only) From address. Omitted callers are unaffected.
  replyTo?: string | string[]
  subject: string
  text: string
  html?: string
  // Optional sender display name. When set, the Resend "from" keeps its
  // verified sending address but presents under this name (e.g. an MJV job's
  // PO email shows "MJV Building Group" instead of the default house brand).
  // No effect on the Graph transport, which always sends from — and presents
  // as — the acting staffer's own mailbox.
  fromName?: string
  // Optional file attachments. `content` is base64-encoded bytes — the shape
  // both Resend and Graph accept. Existing callers that omit this are unaffected.
  attachments?: { filename: string; content: string }[]
  // Counterparty-facing sends pass this so the email lands in the project's
  // Communications feed. Staff-internal mail (digests, alerts) omits it and
  // is never logged.
  log?: CommLogContext
}): Promise<{ sent: boolean; reason?: string }> {
  const toList = Array.isArray(opts.to) ? opts.to : [opts.to]
  const ccList = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : undefined
  const replyToList = opts.replyTo
    ? Array.isArray(opts.replyTo)
      ? opts.replyTo
      : [opts.replyTo]
    : undefined

  // ── Transport 1: the sender's real Microsoft mailbox ──────────────────
  if (graphConfigured()) {
    const fromMailbox = await resolveSenderMailbox(opts.log?.sent_by)
    if (fromMailbox) {
      const g = await sendGraphMail({
        fromMailbox,
        to: toList,
        cc: ccList,
        // No plus-tag Reply-To here on purpose: replies should go to the
        // sender's own inbox, where the Outlook sync captures them.
        replyTo: replyToList,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        attachments: opts.attachments,
      })
      if (g.sent) {
        console.log(
          `[sendEmail] sent "${opts.subject}" via Outlook (${toList.length} recipient(s))`
        )
        if (opts.log) {
          await logCommunication({
            channel: "email",
            direction: "outbound",
            project_id: opts.log.project_id,
            company_id: opts.log.company_id,
            profile_id: opts.log.profile_id,
            sent_by: opts.log.sent_by,
            from_address: fromMailbox,
            to_address: toList.join(", "),
            counterparty_name: opts.log.counterparty_name,
            subject: opts.subject,
            body: opts.text,
            // 'outlook' + internetMessageId is exactly what the sync cron
            // upserts on — so when this message shows up in Sent Items,
            // it merges into this row instead of duplicating.
            source: "outlook",
            source_kind: opts.log.kind,
            provider_id: g.internetMessageId ?? null,
          })
        }
        return { sent: true }
      }
      console.warn(
        `[sendEmail] Graph send failed (${g.reason}) — falling back to Resend`
      )
    }
  }

  // ── Transport 2: Resend ───────────────────────────────────────────────
  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  // One-line, non-sensitive breadcrumb so prod logs show whether email is
  // even configured (we never print the key/recipients). Without this a
  // missing env var is a silent no-op that's impossible to diagnose remotely.
  if (!key || !from) {
    console.warn(
      `[sendEmail] skipped "${opts.subject}" — missing ${
        !key ? "RESEND_API_KEY" : ""
      }${!key && !from ? " + " : ""}${!from ? "RESEND_FROM_EMAIL" : ""}`
    )
    return { sent: false, reason: "RESEND_API_KEY or RESEND_FROM_EMAIL not set" }
  }

  // Project-scoped sends default their Reply-To to the comms inbound
  // address with a project plus-tag (comms+p_<id>@…), so a client/sub reply
  // threads straight back into that job's Communications feed. Callers that
  // set an explicit replyTo (e.g. insurance, utilities) are untouched.
  let replyTo = opts.replyTo
  if (!replyTo && opts.log?.project_id) {
    const inbound = process.env.COMMS_INBOUND_EMAIL
    const at = inbound?.indexOf("@") ?? -1
    if (inbound && at > 0) {
      replyTo = `${inbound.slice(0, at)}+p_${opts.log.project_id}${inbound.slice(at)}`
    }
  }

  const fromLine = opts.fromName ? applyFromName(from, opts.fromName) : from

  const resend = new Resend(key)
  try {
    const { data, error } = await resend.emails.send({
      from: fromLine,
      to: opts.to,
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      ...(opts.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
    })
    if (error) {
      console.error("Resend send error:", error)
      return { sent: false, reason: error.message }
    }
    console.log(
      `[sendEmail] sent "${opts.subject}" to ${toList.length} recipient(s)`
    )
    if (opts.log) {
      await logCommunication({
        channel: "email",
        direction: "outbound",
        project_id: opts.log.project_id,
        company_id: opts.log.company_id,
        profile_id: opts.log.profile_id,
        sent_by: opts.log.sent_by,
        from_address: fromLine,
        to_address: toList.join(", "),
        counterparty_name: opts.log.counterparty_name,
        subject: opts.subject,
        body: opts.text,
        source: "app",
        source_kind: opts.log.kind,
        provider_id: data?.id ?? null,
      })
    }
    return { sent: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("Resend exception:", msg)
    return { sent: false, reason: msg }
  }
}

/**
 * Which mailbox a send goes out from: the acting staff user's own address
 * (via log.sent_by → profiles.email) so the thread lives in THEIR Outlook;
 * otherwise the shared system mailbox (crons, token-page notifications).
 * Null = no Graph identity → caller falls back to Resend.
 */
async function resolveSenderMailbox(
  sentBy?: string | null
): Promise<string | null> {
  if (sentBy) {
    try {
      const admin = createSupabaseAdminClient()
      if (admin) {
        const { data } = await admin
          .from("profiles")
          .select("email, role")
          .eq("id", sentBy)
          .maybeSingle()
        if (data?.role === "staff" && data.email) return data.email
      }
    } catch {
      // fall through to the system mailbox
    }
  }
  return process.env.MS_SYSTEM_MAILBOX || null
}

/**
 * Rebuild a Resend "from" so it presents under `name` while keeping the
 * verified sending address (SPF/DKIM are tied to the address, not the display
 * name, so this is deliverability-safe). Accepts the env value in either
 * `"Name <addr>"` or bare `"addr"` form. Strips line breaks (header
 * injection), then wraps the display name in an RFC 5322 quoted-string so any
 * specials in it (comma, semicolon, parentheses) can't be misread as an
 * address list — escaping embedded quotes/backslashes. Falls back to the
 * original `from` if nothing usable remains.
 */
function applyFromName(from: string, name: string): string {
  const match = from.match(/<([^>]+)>/)
  const address = (match ? match[1] : from).trim()
  const display = name.replace(/[\r\n]/g, "").trim()
  return display && address
    ? `"${display.replace(/["\\]/g, "\\$&")}" <${address}>`
    : from
}

export function appUrl(path: string = "/"): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"
  const normalized = base.startsWith("http") ? base : `https://${base}`
  return new URL(path, normalized).toString()
}
