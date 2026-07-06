import { logCommunication, type CommLogContext } from "@/lib/comms/log"

/**
 * Sends an SMS via Quo (built on OpenPhone — host is api.openphone.com).
 * Graceful no-op if QUO_API_KEY or QUO_FROM_NUMBER is missing so dev / preview
 * environments don't break.
 *
 * QUO_FROM_NUMBER accepts either a Quo phone number ID ("PN…") or an E.164
 * number ("+15555555555"); the Quo API takes either form.
 *
 * Auth header is `Authorization: <api-key>` (raw key, no `Bearer` prefix) —
 * that's what the Quo OpenAPI spec specifies for its apiKey security scheme.
 */
export async function sendQuoSms(opts: {
  to: string
  content: string
  // Counterparty-facing sends pass this so the text lands in the project's
  // Communications feed. Omitted → not logged.
  log?: CommLogContext
}): Promise<{ sent: boolean; reason?: string; providerId?: string }> {
  const key = process.env.QUO_API_KEY
  const from = process.env.QUO_FROM_NUMBER
  if (!key || !from) {
    return { sent: false, reason: "QUO_API_KEY or QUO_FROM_NUMBER not set" }
  }

  const to = normalizeE164(opts.to)
  if (!to) {
    return { sent: false, reason: `Invalid recipient phone number: ${opts.to}` }
  }
  const content = opts.content.trim()
  if (!content) {
    return { sent: false, reason: "Empty message content" }
  }
  if (content.length > 1600) {
    return { sent: false, reason: "Message exceeds 1600-character limit" }
  }

  try {
    const res = await fetch("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], content }),
      // Quo's send endpoint returns 202 Accepted as soon as the message is
      // queued, so a slow response means the upstream is stuck. Match the
      // 5s outbound timeout used by the dashboard integration so a stalled
      // Quo doesn't hold the server action open indefinitely.
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`Quo send failed (${res.status}):`, text)
      return { sent: false, reason: `Quo API ${res.status}: ${text || res.statusText}` }
    }
    // The 202 body carries the created message object; its id is our dedup
    // key against the message.delivered webhook (which logs source 'quo'
    // too, so the unique (source, provider_id) index merges the two).
    let providerId: string | undefined
    try {
      const json = (await res.json()) as { data?: { id?: string }; id?: string }
      providerId = json?.data?.id ?? json?.id ?? undefined
    } catch {
      // Body wasn't JSON — fine, we just log without a provider id.
    }
    if (opts.log) {
      await logCommunication({
        channel: "sms",
        direction: "outbound",
        project_id: opts.log.project_id,
        company_id: opts.log.company_id,
        profile_id: opts.log.profile_id,
        sent_by: opts.log.sent_by,
        from_address: from,
        to_address: to,
        counterparty_name: opts.log.counterparty_name,
        body: content,
        source: "quo",
        source_kind: opts.log.kind,
        provider_id: providerId ?? null,
      })
    }
    return { sent: true, providerId }
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      console.error("Quo send timed out after 5s")
      return { sent: false, reason: "Quo API request timed out" }
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error("Quo send exception:", msg)
    return { sent: false, reason: msg }
  }
}

/**
 * Coerces a US-style phone number string into E.164. Accepts inputs like
 * "(555) 555-5555", "555-555-5555", "5555555555", "+15555555555". Returns
 * null if the input doesn't parse to a plausible E.164 number.
 */
export function normalizeE164(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\+[1-9]\d{1,14}$/.test(raw)) return raw
  const digits = raw.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}
