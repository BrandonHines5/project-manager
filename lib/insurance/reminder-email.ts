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
  // Empty when staff request a certificate from a company with nothing on
  // file yet — the copy switches from "expiring" to "we need a cert".
  expiring: { type: string; expiration_date: string }[]
  uploadUrl: string
}): { subject: string; text: string } {
  const greeting = opts.contactName
    ? `Hi ${opts.contactName.split(" ")[0]},`
    : "Hello,"

  const lines = opts.expiring
    .map(
      (p) =>
        `  • ${INSURANCE_TYPE_LABELS[p.type] ?? p.type} — expires ${formatDate(
          p.expiration_date
        )}`
    )
    .join("\n")

  const body =
    opts.expiring.length > 0
      ? `Our records show the following insurance coverage for ${opts.companyName} is expiring soon:\n\n${lines}\n\nTo keep working on our projects without interruption, please upload your updated certificate of insurance here:\n\n${opts.uploadUrl}\n\nA current certificate showing general liability and workers' compensation coverage is required before the expiration date.`
      : `We need a current certificate of insurance on file for ${opts.companyName} showing general liability and workers' compensation coverage.\n\nPlease upload your certificate here:\n\n${opts.uploadUrl}`

  // Only advertise reply-with-attachment when replies actually route to the
  // inbound pipeline (Reply-To set); otherwise a reply would bounce.
  const replyLine = insuranceReplyTo()
    ? "\n\nYou can also reply to this email with the certificate attached, or have your insurance agent send it directly."
    : ""
  const text = `${greeting}\n\n${body}${replyLine}\n\nThank you,\nHines Homes`

  const subject =
    opts.expiring.length > 0
      ? `Action needed: insurance expiring for ${opts.companyName}`
      : `Certificate of insurance needed for ${opts.companyName}`

  return { subject, text }
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
