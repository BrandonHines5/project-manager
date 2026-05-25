/**
 * Outbound webhook sender for syncing project + progress data to the
 * Hines Homes Dashboard site.
 *
 * The dashboard is a SEPARATE Supabase project. Rather than share a DB, the
 * PM app POSTs signed webhooks on key events:
 *
 *   - project.created
 *   - project.updated
 *   - decision.approved
 *   - daily_log.published      (only fired when visibility = client)
 *   - payment.recorded
 *
 * The dashboard verifies the X-HH-Signature header (HMAC-SHA256 over the raw
 * body, hex) and mirrors what it needs into its own DB.
 *
 * Configuration via env vars (all optional — if any is missing this whole
 * module is a no-op, so local dev / preview deploys don't try to call out):
 *
 *   DASHBOARD_BASE_URL       e.g. https://dashboard.hineshomes.com
 *                            Used to build per-project URLs
 *                            (`/projects/{project_number}`).
 *   DASHBOARD_WEBHOOK_URL    e.g. https://dashboard.hineshomes.com/api/sync
 *                            Endpoint that receives every event POST.
 *   DASHBOARD_WEBHOOK_SECRET shared secret for HMAC signing.
 */

import { createHmac, timingSafeEqual } from "crypto"

export type DashboardEvent =
  | "project.created"
  | "decision.approved"
  | "daily_log.published"
  | "payment.recorded"

export interface DashboardEnvelope<T = unknown> {
  event: DashboardEvent
  occurred_at: string // ISO timestamp
  source: "hh-project-manager"
  data: T
}

/**
 * Returns the dashboard base URL configured for this deploy, or null if not
 * configured. Callers should null-check and skip URL generation gracefully.
 */
export function dashboardBaseUrl(): string | null {
  const v = process.env.DASHBOARD_BASE_URL
  return v && v.length > 0 ? v.replace(/\/+$/, "") : null
}

/**
 * Builds the canonical client-facing dashboard URL for a project, e.g.
 * `https://dashboard.hineshomes.com/projects/2026-001`. Returns null if
 * DASHBOARD_BASE_URL is not configured.
 *
 * The slug is the project_number (chosen by the user during PR review).
 */
export function dashboardProjectUrl(projectNumber: string): string | null {
  const base = dashboardBaseUrl()
  if (!base) return null
  return `${base}/projects/${encodeURIComponent(projectNumber)}`
}

/**
 * POSTs a signed event payload to the dashboard webhook. Best-effort:
 * any failure is logged and swallowed so a webhook outage cannot fail a
 * user-facing server action. The PM app remains the source of truth — if
 * the dashboard misses an event it can be re-synced from a future change
 * or a manual re-fire endpoint.
 */
export async function sendDashboardWebhook<T>(
  event: DashboardEvent,
  data: T
): Promise<{ sent: boolean; reason?: string }> {
  // Docs state the integration is a no-op when ANY of the three vars is
  // unset. Be strict so a partially-configured preview deploy doesn't fire
  // surprise webhooks at the production dashboard.
  const base = process.env.DASHBOARD_BASE_URL
  const url = process.env.DASHBOARD_WEBHOOK_URL
  const secret = process.env.DASHBOARD_WEBHOOK_SECRET
  if (!base || !url || !secret) {
    return {
      sent: false,
      reason:
        "Dashboard env incomplete (DASHBOARD_BASE_URL / DASHBOARD_WEBHOOK_URL / DASHBOARD_WEBHOOK_SECRET)",
    }
  }

  const envelope: DashboardEnvelope<T> = {
    event,
    occurred_at: new Date().toISOString(),
    source: "hh-project-manager",
    data,
  }
  const body = JSON.stringify(envelope)
  const signature = createHmac("sha256", secret).update(body).digest("hex")

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hh-event": event,
        "x-hh-signature": signature,
      },
      body,
      // Keep this short — we never want webhook latency to block a save.
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.warn(
        `[dashboard webhook] ${event} -> ${res.status} ${res.statusText}: ${text.slice(0, 200)}`
      )
      return { sent: false, reason: `HTTP ${res.status}` }
    }
    return { sent: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[dashboard webhook] ${event} failed:`, msg)
    return { sent: false, reason: msg }
  }
}

/**
 * Constant-time HMAC signature verification helper. Exported so the
 * dashboard side (or a future inbound webhook in this app) can use the same
 * routine without rolling its own.
 */
export function verifyDashboardSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  if (expected.length !== signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}
