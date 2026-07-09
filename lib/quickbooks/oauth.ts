import "server-only"
import {
  QBO_AUTHORIZE_URL,
  QBO_TOKEN_URL,
  QBO_REVOKE_URL,
  QBO_SCOPE,
  basicAuthHeader,
  qboConfig,
} from "./config"
import {
  getQboConnection,
  updateQboTokens,
  type QboConnection,
} from "./storage"

/**
 * OAuth 2.0 authorization-code flow for QuickBooks Online.
 *
 * Token lifetimes: access token ~1h, refresh token ~100 days ROLLING. Intuit
 * returns a fresh refresh token periodically and invalidates the prior one, so
 * getValidAccessToken() persists the rotated refresh token on every refresh.
 */

// Refresh a little before actual expiry so an in-flight request never races a
// hard expiry.
const EXPIRY_SKEW_MS = 60_000

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number // seconds, ~3600
  x_refresh_token_expires_in: number // seconds, ~8726400 (~101 days)
  token_type?: string
}

/** Build the Intuit consent URL the staffer is redirected to. */
export function buildAuthorizeUrl(state: string): string | null {
  const cfg = qboConfig()
  if (!cfg) return null
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
  })
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`
}

function expiryTimestamps(tok: TokenResponse) {
  const now = Date.now()
  return {
    access_token_expires_at: new Date(
      now + tok.expires_in * 1000 - EXPIRY_SKEW_MS
    ).toISOString(),
    refresh_token_expires_at: new Date(
      now + tok.x_refresh_token_expires_in * 1000
    ).toISOString(),
  }
}

/** Exchange the authorization code for tokens (callback route). */
export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  refresh_token_expires_at: string
} | null> {
  const cfg = qboConfig()
  if (!cfg) return null
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    console.error(`[qbo] code exchange failed (${res.status}): ${text.slice(0, 300)}`)
    return null
  }
  const tok = (await res.json()) as TokenResponse
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    ...expiryTimestamps(tok),
  }
}

/** Refresh the access token; returns the rotated token set. */
async function refreshTokens(refreshToken: string): Promise<{
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  refresh_token_expires_at: string
} | null> {
  const cfg = qboConfig()
  if (!cfg) return null
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    console.error(`[qbo] token refresh failed (${res.status}): ${text.slice(0, 300)}`)
    return null
  }
  const tok = (await res.json()) as TokenResponse
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    ...expiryTimestamps(tok),
  }
}

/**
 * A valid access token for the stored connection, refreshing (and persisting
 * the rotated refresh token) when the current one is expired/near expiry.
 * Returns the token + realm/environment, or null if not connected / refresh
 * failed. Pass `force` to refresh even if the current token looks valid (used
 * to recover from a 401).
 */
export async function getValidAccessToken(
  force = false
): Promise<{ accessToken: string; realmId: string; connection: QboConnection } | null> {
  const conn = await getQboConnection()
  if (!conn) return null

  const expiresAt = new Date(conn.access_token_expires_at).getTime()
  const stillValid = Number.isFinite(expiresAt) && expiresAt > Date.now()
  if (stillValid && !force) {
    return { accessToken: conn.access_token, realmId: conn.realm_id, connection: conn }
  }

  const refreshed = await refreshTokens(conn.refresh_token)
  if (!refreshed) return null
  await updateQboTokens(conn.realm_id, refreshed)
  return {
    accessToken: refreshed.access_token,
    realmId: conn.realm_id,
    connection: { ...conn, ...refreshed },
  }
}

/** Best-effort token revocation on disconnect (revokes the refresh token). */
export async function revokeToken(refreshToken: string): Promise<void> {
  const cfg = qboConfig()
  if (!cfg) return
  try {
    await fetch(QBO_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    console.warn("[qbo] token revoke failed:", e instanceof Error ? e.message : e)
  }
}
