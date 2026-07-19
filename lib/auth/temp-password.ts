import "server-only"
import { randomInt } from "node:crypto"

/**
 * Generate a 14-char temporary password using crypto-grade randomness.
 * Server-only because the result is an auth secret — it must never bounce
 * through the browser. Shared by team-member invites/resets and new-org
 * owner provisioning so every generated credential has the same shape.
 *
 * Uses crypto.randomInt for uniform character selection (no modulo bias);
 * the omitted look-alike characters (0/O, 1/I/l) keep it readable when a
 * staffer reads it aloud to share it.
 */
export function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  const symbols = "!@#$%&*?"
  let out = ""
  for (let i = 0; i < 13; i++) out += alphabet[randomInt(alphabet.length)]
  out += symbols[randomInt(symbols.length)]
  return out
}
