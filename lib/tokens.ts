import "server-only"
import { randomBytes } from "crypto"

// Unguessable access token for public bid/PO links (43 base64url chars =
// 256 bits). The token IS the credential: anyone holding the link can act
// as that recipient, so revocation = nulling the column.
export function generateAccessToken() {
  return randomBytes(32).toString("base64url")
}

// Shape-check a token before hitting the DB with it. Rejects junk URLs
// early and guarantees the value is safe to use in a .eq() filter.
export const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
