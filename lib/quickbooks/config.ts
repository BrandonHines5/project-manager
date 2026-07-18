import "server-only"

/**
 * QuickBooks Online integration config. All values come from env vars set in
 * Vercel (and .env.local for dev). When the client id/secret are unset the
 * integration is treated as not configured and every entry point no-ops or
 * returns a typed "not configured" result — mirroring the specmagician / quo
 * graceful-degradation pattern so preview builds don't break.
 *
 * Env:
 *   QBO_CLIENT_ID       — Intuit app Production Client ID
 *   QBO_CLIENT_SECRET   — Intuit app Production Client Secret
 *   QBO_REDIRECT_URI    — OAuth redirect, must EXACTLY match the URI registered
 *                         in the Intuit app (e.g. https://app.buildfox.ai/api/qbo/callback)
 *   QBO_ENVIRONMENT     — 'production' (default) | 'sandbox'
 */

export type QboEnvironment = "production" | "sandbox"

/** The configured QBO environment; defaults to production. */
export function qboEnvironment(): QboEnvironment {
  return process.env.QBO_ENVIRONMENT === "sandbox" ? "sandbox" : "production"
}

/** Resolved OAuth credentials, or null when any required env var is unset. */
export function qboConfig() {
  const clientId = process.env.QBO_CLIENT_ID
  const clientSecret = process.env.QBO_CLIENT_SECRET
  const redirectUri = process.env.QBO_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) return null
  return { clientId, clientSecret, redirectUri, environment: qboEnvironment() }
}

/** Whether the QuickBooks integration has its credentials configured. */
export function qboConfigured(): boolean {
  return qboConfig() !== null
}

// OAuth 2.0 endpoints (same for sandbox and production — the environment is
// selected by which key set you authenticate with, not by URL).
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2"
export const QBO_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
export const QBO_REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"

// Accounting scope only — we create purchase orders and read reference data.
export const QBO_SCOPE = "com.intuit.quickbooks.accounting"

// Current default minor version (v1–74 are deprecated / coerced to 75).
export const QBO_MINOR_VERSION = "75"

/** Base URL for the Accounting API, per environment. */
export function qboApiBase(environment: QboEnvironment): string {
  return environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com"
}

/** HTTP Basic auth header value for the token/revoke endpoints. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
}
