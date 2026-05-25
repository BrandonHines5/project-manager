import { Resend } from "resend"

/**
 * Sends a transactional email via Resend. Returns immediately as a no-op if
 * RESEND_API_KEY is not configured — so we can wire send calls into actions
 * without breaking dev environments.
 */
export async function sendEmail(opts: {
  to: string | string[]
  subject: string
  text: string
  html?: string
}): Promise<{ sent: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  if (!key || !from) {
    return { sent: false, reason: "RESEND_API_KEY or RESEND_FROM_EMAIL not set" }
  }

  const resend = new Resend(key)
  try {
    const { error } = await resend.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    })
    if (error) {
      console.error("Resend send error:", error)
      return { sent: false, reason: error.message }
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
