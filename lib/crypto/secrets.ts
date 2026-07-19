// AES-256-GCM envelope encryption for per-org integration secrets (B4).
//
// The master key lives ONLY in the server env (`INTEGRATION_SECRETS_KEY`,
// base64 of 32 random bytes — set in Vercel, never NEXT_PUBLIC). Envelopes
// are what get stored in org_integrations.secrets: SQL access alone cannot
// read the plaintext, and a leaked database backup is useless without the
// env key. Everything here FAILS CLOSED — a missing/malformed key or a
// bad envelope throws instead of degrading to plaintext or null.
//
// Rotation: each envelope records the key id (`kid`) that sealed it. Set the
// new key as INTEGRATION_SECRETS_KEY and the old one as
// INTEGRATION_SECRETS_KEY_PREVIOUS; decryption accepts both while a
// re-encrypt sweep rewrites rows under the new key, then the previous var
// is removed.
//
// The optional `aad` (additional authenticated data) binds an envelope to
// its location — callers pass `${orgId}/${provider}` so a row's envelope
// can't be copied onto another org's row and still decrypt.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

export type SecretEnvelope = {
  v: 1
  /** First 8 hex chars of sha256(master key) — which key sealed this. */
  kid: string
  /** base64 12-byte GCM nonce. */
  iv: string
  /** base64 ciphertext. */
  ct: string
  /** base64 16-byte GCM auth tag. */
  tag: string
}

function parseKey(name: string): Buffer | null {
  const raw = process.env[name]
  if (!raw) return null
  let key: Buffer
  try {
    key = Buffer.from(raw, "base64")
  } catch {
    throw new Error(`${name} is not valid base64.`)
  }
  if (key.length !== 32) {
    throw new Error(
      `${name} must be base64 of exactly 32 random bytes (got ${key.length}).`
    )
  }
  return key
}

function kidOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8)
}

function activeKey(): { key: Buffer; kid: string } {
  const key = parseKey("INTEGRATION_SECRETS_KEY")
  if (!key) {
    throw new Error(
      "INTEGRATION_SECRETS_KEY is not set — integration secrets are unavailable."
    )
  }
  return { key, kid: kidOf(key) }
}

/** Active key first, then the rotation predecessor when configured. */
function decryptionKeys(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>()
  const active = activeKey()
  keys.set(active.kid, active.key)
  const previous = parseKey("INTEGRATION_SECRETS_KEY_PREVIOUS")
  if (previous) keys.set(kidOf(previous), previous)
  return keys
}

export function isSecretEnvelope(v: unknown): v is SecretEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    o.v === 1 &&
    typeof o.kid === "string" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string" &&
    typeof o.tag === "string"
  )
}

/**
 * Seal a JSON payload under the active master key. `aad` (when provided)
 * must be passed identically to decryptSecrets — use it to bind the
 * envelope to its storage location.
 */
export function encryptSecrets(
  payload: Record<string, unknown>,
  aad?: string
): SecretEnvelope {
  const { key, kid } = activeKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"))
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8")
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    v: 1,
    kid,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  }
}

/**
 * Open an envelope. Throws on any problem — unknown shape, unknown key id
 * (master key rotated away without a sweep), wrong aad, or tampered
 * ciphertext. Never returns partial or plaintext-ish fallbacks.
 */
export function decryptSecrets(
  envelope: unknown,
  aad?: string
): Record<string, unknown> {
  if (!isSecretEnvelope(envelope)) {
    throw new Error("Stored secrets are not a valid envelope.")
  }
  const key = decryptionKeys().get(envelope.kid)
  if (!key) {
    throw new Error(
      `No master key matches kid ${envelope.kid} — was the key rotated without a re-encrypt sweep?`
    )
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  )
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, "base64")),
    decipher.final(),
  ])
  const parsed: unknown = JSON.parse(plaintext.toString("utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted secrets are not an object.")
  }
  return parsed as Record<string, unknown>
}

/** True when the active master key is configured (encryption available). */
export function secretsConfigured(): boolean {
  try {
    activeKey()
    return true
  } catch {
    return false
  }
}
