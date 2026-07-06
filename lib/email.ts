import { Resend } from "resend"
import { logCommunication, type CommLogContext } from "@/lib/comms/log"

/**
 * Sends a transactional email via Resend. Returns immediately as a no-op if
 * RESEND_API_KEY is not configured — so we can wire send calls into actions
 * without breaking dev environments.
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
  // Optional file attachments. `content` is base64-encoded bytes — Resend's
  // expected shape. Existing callers that omit this are unaffected.
  attachments?: { filename: string; content: string }[]
  // Counterparty-facing sends pass this so the email lands in the project's
  // Communications feed. Staff-internal mail (digests, alerts) omits it and
  // is never logged.
  log?: CommLogContext
}): Promise<{ sent: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  // One-line, non-sensitive breadcrumb so prod logs show whether email is
  // even configured (we never print the key/recipients). Without this a
  // missing env var is a silent no-op that's impossible to diagnose remotely.
  const recipientCount = Array.isArray(opts.to) ? opts.to.length : 1
  if (!key || !from) {
    console.warn(
      `[sendEmail] skipped "${opts.subject}" — missing ${
        !key ? "RESEND_API_KEY" : ""
      }${!key && !from ? " + " : ""}${!from ? "RESEND_FROM_EMAIL" : ""}`
    )
    return { sent: false, reason: "RESEND_API_KEY or RESEND_FROM_EMAIL not set" }
  }

  const resend = new Resend(key)
  try {
    const { data, error } = await resend.emails.send({
      from,
      to: opts.to,
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
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
      `[sendEmail] sent "${opts.subject}" to ${recipientCount} recipient(s)`
    )
    if (opts.log) {
      const toList = Array.isArray(opts.to) ? opts.to : [opts.to]
      await logCommunication({
        channel: "email",
        direction: "outbound",
        project_id: opts.log.project_id,
        company_id: opts.log.company_id,
        profile_id: opts.log.profile_id,
        sent_by: opts.log.sent_by,
        from_address: from,
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

export function appUrl(path: string = "/"): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"
  const normalized = base.startsWith("http") ? base : `https://${base}`
  return new URL(path, normalized).toString()
}
