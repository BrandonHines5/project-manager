import "server-only"

// Shared copy for the "your insurance is expiring, please send us a new
// certificate" email — used by the daily cron and by the staff "Send
// request" button, so the sub gets the same message either way.

export const INSURANCE_TYPE_LABELS: Record<string, string> = {
  general_liability: "General Liability",
  workers_comp: "Workers' Compensation",
  auto: "Auto Liability",
  umbrella: "Umbrella / Excess Liability",
}

/**
 * Reply-To for insurance emails: the Resend RECEIVING address that feeds the
 * /api/inbound/insurance webhook (e.g. insurance@<subdomain>.resend.app, or
 * a custom inbound address). The From address is Resend's SENDING identity,
 * which can't receive mail — without this, hitting "Reply" on a request
 * email bounces. When unset, the email copy drops the "reply with your
 * certificate attached" suggestion entirely.
 */
export function insuranceReplyTo(): string | undefined {
  const v = process.env.INSURANCE_INBOUND_EMAIL?.trim()
  return v && v.includes("@") ? v : undefined
}

export function buildInsuranceRequestEmail(opts: {
  companyName: string
  contactName?: string | null
  // Only REQUIRED coverages (GL / workers' comp) belong here — auto/umbrella
  // are filtered out by the callers so they never trigger or appear. Empty
  // when staff request a cert from a company with nothing expiring: the copy
  // switches from "expiring" to "we need a cert".
  expiring: { type: string; expiration_date: string }[]
  uploadUrl: string
}): { subject: string; text: string; html: string } {
  const greeting = opts.contactName
    ? `Hi ${opts.contactName.split(" ")[0]},`
    : "Hello,"

  const hasExpiring = opts.expiring.length > 0

  // Only advertise reply-with-attachment when replies actually route to the
  // inbound pipeline (Reply-To set); otherwise a reply would bounce.
  const showReplyLine = Boolean(insuranceReplyTo())
  const replyText = showReplyLine
    ? "\n\nYou can also reply to this email with the certificate attached, or have your insurance agent send it directly."
    : ""

  const subject = hasExpiring
    ? `Action needed: insurance expiring for ${opts.companyName}`
    : `Certificate of insurance needed for ${opts.companyName}`

  // ----- plain-text version (fallback for text-only clients) -----
  const textLines = opts.expiring
    .map(
      (p) =>
        `  • ${INSURANCE_TYPE_LABELS[p.type] ?? p.type} — expires ${formatDate(
          p.expiration_date
        )}`
    )
    .join("\n")

  const textBody = hasExpiring
    ? `Our records show the following insurance coverage for ${opts.companyName} is expiring soon:\n\n${textLines}\n\nTo keep working on our projects without interruption, please upload your updated certificate of insurance here:\n\nUpload Insurance: ${opts.uploadUrl}\n\nA current certificate showing general liability and workers' compensation coverage is required before the expiration date.`
    : `We need a current certificate of insurance on file for ${opts.companyName} showing general liability and workers' compensation coverage.\n\nPlease upload your certificate here:\n\nUpload Insurance: ${opts.uploadUrl}`

  const text = `${greeting}\n\n${textBody}${replyText}\n\nThank you,\nHines Homes`

  // ----- HTML version (what Outlook/Gmail render) -----
  const company = escapeHtml(opts.companyName)
  const href = escapeHtml(opts.uploadUrl)
  const button = `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background:#1f6feb;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Upload Insurance</a></p>`

  const htmlBody = hasExpiring
    ? `<p style="margin:0 0 12px;">Our records show the following insurance coverage for <strong>${company}</strong> is expiring soon:</p>
<ul style="margin:0 0 12px;padding-left:20px;">${opts.expiring
        .map(
          (p) =>
            `<li>${escapeHtml(
              INSURANCE_TYPE_LABELS[p.type] ?? p.type
            )} — expires ${escapeHtml(formatDate(p.expiration_date))}</li>`
        )
        .join("")}</ul>
<p style="margin:0 0 4px;">To keep working on our projects without interruption, please upload your updated certificate of insurance:</p>
${button}
<p style="margin:0;">A current certificate showing general liability and workers' compensation coverage is required before the expiration date.</p>`
    : `<p style="margin:0 0 4px;">We need a current certificate of insurance on file for <strong>${company}</strong> showing general liability and workers' compensation coverage.</p>
<p style="margin:0 0 4px;">Please upload your certificate:</p>
${button}`

  const replyHtml = showReplyLine
    ? `<p style="margin:16px 0 0;">You can also reply to this email with the certificate attached, or have your insurance agent send it directly.</p>`
    : ""

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;">
<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
${htmlBody}
${replyHtml}
<p style="margin:16px 0 0;">Thank you,<br>Hines Homes</p>
</div>`

  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}
