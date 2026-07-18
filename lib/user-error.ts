// Deliberate, user-facing errors thrown from server actions.
//
// In production Next.js masks the message of any error thrown in a server
// action — the browser receives "An error occurred in the Server Components
// render…" with only the error's `digest` forwarded verbatim (Next respects a
// digest that is already set instead of generating a hash). Carrying the
// user-facing sentence inside the digest lets the client show the real
// message. Internal failures (DB errors, unexpected states) should stay plain
// `Error`s — their details are exactly what masking is for; the client falls
// back to the catch site's generic message for those.

export const USER_ERROR_DIGEST_PREFIX = "PM_USER_ERROR:"

export function userError(message: string): Error {
  const err = new Error(message) as Error & { digest: string }
  err.digest = USER_ERROR_DIGEST_PREFIX + message
  return err
}

/** The user-facing message a server action packed into `digest`, if any. */
export function userErrorMessageFromDigest(e: unknown): string | null {
  if (e && typeof e === "object" && "digest" in e) {
    const digest = (e as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith(USER_ERROR_DIGEST_PREFIX)) {
      return digest.slice(USER_ERROR_DIGEST_PREFIX.length)
    }
  }
  return null
}
