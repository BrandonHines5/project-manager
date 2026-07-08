/**
 * Outbound webhook sender for syncing project + progress data to the
 * Hines Homes Dashboard site, plus an inbound API client for pulling
 * dashboard-owned project + client info into PM at project start.
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
 *                            (`/projects/{project_number}`) AND as the API
 *                            base for inbound reads.
 *   DASHBOARD_WEBHOOK_URL    e.g. https://dashboard.hineshomes.com/api/sync
 *                            Endpoint that receives every event POST.
 *   DASHBOARD_WEBHOOK_SECRET shared secret for HMAC signing (outbound).
 *   DASHBOARD_API_SECRET     bearer token for INBOUND reads (PM → dashboard).
 *                            Distinct from the webhook secret so it can be
 *                            rotated independently. The dashboard validates
 *                            this on GET /api/projects/* endpoints.
 *   DASHBOARD_PROTECTION_BYPASS (optional) — if the dashboard's Vercel
 *                            deployment has "Protection Bypass for
 *                            Automation" enabled, paste the generated
 *                            secret here. Every outbound request from PM
 *                            then carries `x-vercel-protection-bypass`
 *                            so Vercel's edge lets us through to the
 *                            function. Leave empty if the dashboard isn't
 *                            behind Deployment Protection.
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
 * Adds the Vercel Protection Bypass header when DASHBOARD_PROTECTION_BYPASS
 * is set. Without this header, Vercel's edge returns 403 on a protected
 * deployment before our endpoint code even runs — so every outbound call
 * needs to include it. No-op (returns the headers unchanged) when the env
 * var isn't set, which is the right behavior for dashboards without
 * Deployment Protection.
 */
function withVercelBypass(headers: Record<string, string>): Record<string, string> {
  // Trim before truthy-check — a whitespace-only value from an env-var paste
  // would otherwise emit a header that Vercel rejects, producing a confusing
  // 403 instead of the clean "no bypass configured" fallthrough.
  const bypass = process.env.DASHBOARD_PROTECTION_BYPASS?.trim()
  if (!bypass) return headers
  return { ...headers, "x-vercel-protection-bypass": bypass }
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
      headers: withVercelBypass({
        "content-type": "application/json",
        "x-hh-event": event,
        "x-hh-signature": signature,
      }),
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

// ---------------------------------------------------------------------------
// Inbound API client (PM → dashboard reads)
// ---------------------------------------------------------------------------

/**
 * Shape returned by the dashboard's project endpoints. Kept narrow on
 * purpose — only the fields PM actually consumes at project-creation time.
 * The dashboard is the source of truth for everything here; PM mirrors them.
 */
export interface DashboardProject {
  // The dashboard's OWN internal project id (a uuid). The dashboard's
  // /projects/[id] route is keyed on this, NOT on project_number — linking
  // by project_number produces "invalid input syntax for type uuid". We
  // capture it so PM can build a working dashboard link. Null if the
  // dashboard response doesn't include it.
  id: string | null
  project_number: string
  name: string
  address: string | null
  contract_price: number | null
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  // The dashboard tracks up to two clients per project; the second slot is
  // optional. Resolved (name/email/phone) from the dashboard's clients table.
  client_name_2: string | null
  client_email_2: string | null
  client_phone_2: string | null
  // Who's managing the job on the dashboard side. Free-text label (a name or
  // email), mirrored into PM for display. Null if not provided.
  project_manager: string | null
  // A canonical, absolute dashboard URL for this project, if the dashboard
  // hands one back directly. Preferred over building one ourselves.
  url: string | null
  // The CRM's "Projected Start Date", mirrored through the dashboard. ISO date
  // string or null (dashboards may not capture it). PM anchors the new job's
  // Job Start milestone to this on the template-copy path.
  start_date?: string | null
}

/**
 * Builds the dashboard link for a project that opens the actual job. Prefers
 * an absolute URL the dashboard supplied, then the dashboard's internal id
 * (the route's real key), and only falls back to project_number as a last
 * resort (that path 500s on uuid-keyed dashboards — see DashboardProject.id).
 * Returns null when DASHBOARD_BASE_URL isn't configured.
 */
export function dashboardUrlForProject(p: {
  id?: string | null
  url?: string | null
  project_number: string
}): string | null {
  const base = dashboardBaseUrl()
  if (!base) return null
  if (p.url && /^https?:\/\//i.test(p.url)) return p.url
  if (p.id) return `${base}/projects/${encodeURIComponent(p.id)}`
  return `${base}/projects/${encodeURIComponent(p.project_number)}`
}

// Reads the first present, non-empty string among the given keys. The
// dashboard may name fields slightly differently (project_manager vs pm vs
// manager); accept the common aliases so the pull works without a dashboard
// change.
function firstString(
  r: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const k of keys) {
    const v = r[k]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return null
}

function dashboardApiHeaders(): Record<string, string> | null {
  const secret = process.env.DASHBOARD_API_SECRET
  if (!secret) return null
  return withVercelBypass({
    accept: "application/json",
    authorization: `Bearer ${secret}`,
  })
}

/**
 * Lists projects on the dashboard that have NOT yet been adopted into PM
 * (i.e. the dashboard's `pm_attached_at` is NULL). Returns [] if the
 * integration env is incomplete OR the dashboard is unreachable — the New
 * Project UI keeps its "create blank" path as a fallback either way.
 */
export async function listAvailableDashboardProjects(): Promise<
  DashboardProject[]
> {
  const base = dashboardBaseUrl()
  const headers = dashboardApiHeaders()
  if (!base || !headers) return []
  try {
    const res = await fetch(`${base}/api/projects/available`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
      // Don't cache — staff create projects rarely but the freshness matters
      // when they do (a project added in the dashboard 30s ago should show).
      cache: "no-store",
    })
    if (!res.ok) {
      console.warn(
        `[dashboard list] HTTP ${res.status} ${res.statusText} — returning []`
      )
      return []
    }
    const json = (await res.json()) as unknown
    return normalizeDashboardProjects(json)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn("[dashboard list] failed:", msg)
    return []
  }
}

/**
 * Fetches one dashboard project by its project_number. Returns null if the
 * env is incomplete, the dashboard is down, or the project doesn't exist
 * there. The caller decides what to do with null (typically: surface a
 * field error so staff knows the pull didn't work).
 */
export async function getDashboardProject(
  projectNumber: string
): Promise<DashboardProject | null> {
  const base = dashboardBaseUrl()
  const headers = dashboardApiHeaders()
  if (!base || !headers) return null
  try {
    const res = await fetch(
      `${base}/api/projects/${encodeURIComponent(projectNumber)}`,
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      }
    )
    if (res.status === 404) return null
    if (!res.ok) {
      console.warn(
        `[dashboard get ${projectNumber}] HTTP ${res.status} ${res.statusText}`
      )
      return null
    }
    const json = (await res.json()) as unknown
    return normalizeDashboardProject(json)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[dashboard get ${projectNumber}] failed:`, msg)
    return null
  }
}

// The dashboard may evolve its response shape, so we coerce defensively
// instead of trusting it blindly. Missing fields become null/[].
function normalizeDashboardProjects(json: unknown): DashboardProject[] {
  if (!Array.isArray(json)) return []
  return json
    .map((row) => normalizeDashboardProject(row))
    .filter((p): p is DashboardProject => p !== null)
}

// Number coercion that preserves valid zero. The naive `Number(x) || null`
// pattern silently turns "0"/0 into null — but a $0 contract price is a
// legitimate value (e.g. spec-build placeholder), so we use Number.isFinite
// to distinguish "couldn't be parsed" from "parsed as 0".
function coerceNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeDashboardProject(json: unknown): DashboardProject | null {
  if (!json || typeof json !== "object") return null
  const r = json as Record<string, unknown>
  const projectNumber =
    typeof r.project_number === "string" ? r.project_number : null
  const name = typeof r.name === "string" ? r.name : null
  // project_number + name are the only truly required fields — without them
  // we can't even render a sensible picker row.
  if (!projectNumber || !name) return null
  return {
    id: firstString(r, ["id", "project_id", "uuid"]),
    project_number: projectNumber,
    name,
    address: typeof r.address === "string" ? r.address : null,
    contract_price: coerceNumberOrNull(r.contract_price),
    client_name: typeof r.client_name === "string" ? r.client_name : null,
    client_email: typeof r.client_email === "string" ? r.client_email : null,
    client_phone: typeof r.client_phone === "string" ? r.client_phone : null,
    client_name_2: firstString(r, ["client_name_2", "client_2_name"]),
    client_email_2: firstString(r, ["client_email_2", "client_2_email"]),
    client_phone_2: firstString(r, ["client_phone_2", "client_2_phone"]),
    project_manager: firstString(r, [
      "project_manager",
      "project_manager_name",
      "pm",
      "pm_name",
      "manager",
    ]),
    url: firstString(r, ["url", "dashboard_url", "link", "permalink"]),
    // The CRM calls this "Projected Start Date"; accept the common field
    // names so the pull works whatever the dashboard names it.
    start_date: firstString(r, [
      "start_date",
      "projected_start_date",
      "projected_start",
    ]),
  }
}
