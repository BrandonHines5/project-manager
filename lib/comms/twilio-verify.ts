import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Validates an inbound Twilio webhook's `X-Twilio-Signature`. Twilio signs the
 * request as base64(HMAC-SHA1(authToken, data)), where `data` is the exact
 * request URL followed by every POST parameter — keys sorted
 * lexicographically — concatenated as key+value with no separators.
 *
 * We validate against the URL we configured as the number's SmsUrl (the
 * canonical appUrl webhook), not the proxy-rewritten req.url, so Vercel's edge
 * can't change the string Twilio signed. Returns false on any mismatch or a
 * missing signature — the route rejects with 403, so a forged POST can't
 * inject a communications row.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
  authToken: string
): boolean {
  if (!signature) return false
  let data = url
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]
  }
  const expected = createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64")
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  // timingSafeEqual throws on length mismatch — guard so a wrong-length forgery
  // is a clean false, not an exception.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
