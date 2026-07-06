import crypto from "node:crypto"

/**
 * Verifies a Quo/OpenPhone webhook signature.
 *
 * Header `openphone-signature` has the form `hmac;1;<timestamp>;<base64 sig>`
 * (possibly several, comma-separated, for future key rotation). The signature
 * is HMAC-SHA256 of `${timestamp}.${rawBody}` keyed with the BASE64-DECODED
 * signing secret shown when the webhook was created in the Quo dashboard.
 */
export function verifyQuoSignature(
  rawBody: string,
  header: string | null,
  signingSecretB64: string
): boolean {
  if (!header) return false
  let key: Buffer
  try {
    key = Buffer.from(signingSecretB64, "base64")
  } catch {
    return false
  }
  if (key.length === 0) return false

  for (const candidate of header.split(",")) {
    const parts = candidate.trim().split(";")
    if (parts.length !== 4) continue
    const [scheme, , timestamp, digest] = parts
    if (scheme !== "hmac" || !timestamp || !digest) continue
    const computed = crypto
      .createHmac("sha256", key)
      .update(`${timestamp}.${rawBody}`)
      .digest("base64")
    const a = Buffer.from(computed)
    const b = Buffer.from(digest)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
  }
  return false
}
