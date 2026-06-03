import "server-only"
import type { Enums } from "@/lib/db/types"

/**
 * Central Identity directory client (PM → dashboard reads).
 *
 * After Microsoft Entra confirms WHO a staff member is, we ask the central
 * directory (hosted by the dashboard) WHETHER they're allowed and WHAT role
 * they have. The directory is the source of truth for staff identity; PM
 * mirrors the resolved role into profiles.role so existing RLS keeps working.
 *
 * Config (reuses the dashboard integration env):
 *   IDENTITY_BASE_URL        e.g. https://dashboard.hineshomes.com
 *                            Falls back to DASHBOARD_BASE_URL when unset.
 *   DASHBOARD_API_SECRET     bearer token the resolve endpoint validates.
 *   DASHBOARD_PROTECTION_BYPASS (optional) — Vercel deployment-protection
 *                            bypass, same as the dashboard webhook client.
 *
 * If the base URL or secret is missing, every resolve returns
 * { ok: false, reason: "not_configured" } so the caller fails CLOSED (Entra
 * membership alone never grants access).
 */

export type PmRole = Enums<"user_role"> // 'staff' | 'trade' | 'client'

export interface DirectoryRecord {
  id: string
  name: string | null
  email: string | null
  entra_user_id: string | null
  is_active: boolean
  role: string | null
  app_roles: Record<string, string> | null
}

export type ResolveResult =
  | { ok: true; record: DirectoryRecord }
  | { ok: false; reason: "not_configured" | "not_found" | "inactive" | "error" }

// PM's stable key in the directory's app_roles map.
const PM_APP_KEY = "pm"

function identityBaseUrl(): string | null {
  const v = (process.env.IDENTITY_BASE_URL || process.env.DASHBOARD_BASE_URL)?.trim()
  return v && v.length > 0 ? v.replace(/\/+$/, "") : null
}

function withBypass(
  headers: Record<string, string>
): Record<string, string> {
  const bypass = process.env.DASHBOARD_PROTECTION_BYPASS?.trim()
  if (!bypass) return headers
  return { ...headers, "x-vercel-protection-bypass": bypass }
}

/**
 * Resolves a person against the central directory. Prefers the stable Entra
 * object id; falls back to email. Returns a typed result the caller uses as
 * an auth gate — never throws.
 */
export async function resolveDirectoryIdentity(input: {
  entraUserId?: string | null
  email?: string | null
}): Promise<ResolveResult> {
  const base = identityBaseUrl()
  const secret = process.env.DASHBOARD_API_SECRET?.trim()
  if (!base || !secret) return { ok: false, reason: "not_configured" }

  const query = input.entraUserId
    ? `entra_user_id=${encodeURIComponent(input.entraUserId)}`
    : input.email
      ? `email=${encodeURIComponent(input.email)}`
      : null
  if (!query) return { ok: false, reason: "not_found" }

  try {
    const res = await fetch(`${base}/api/identity/resolve?${query}`, {
      method: "GET",
      headers: withBypass({
        accept: "application/json",
        authorization: `Bearer ${secret}`,
      }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    })
    if (res.status === 404) return { ok: false, reason: "not_found" }
    if (!res.ok) {
      console.warn(`[identity] resolve HTTP ${res.status} ${res.statusText}`)
      return { ok: false, reason: "error" }
    }
    const record = normalize((await res.json()) as unknown)
    if (!record) return { ok: false, reason: "error" }
    if (record.is_active !== true) return { ok: false, reason: "inactive" }
    return { ok: true, record }
  } catch (e) {
    console.warn(
      "[identity] resolve failed:",
      e instanceof Error ? e.message : String(e)
    )
    return { ok: false, reason: "error" }
  }
}

function normalize(json: unknown): DirectoryRecord | null {
  if (!json || typeof json !== "object") return null
  const r = json as Record<string, unknown>
  if (typeof r.id !== "string") return null
  let app_roles: Record<string, string> | null = null
  if (r.app_roles && typeof r.app_roles === "object") {
    app_roles = Object.fromEntries(
      Object.entries(r.app_roles as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  }
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : null,
    email: typeof r.email === "string" ? r.email : null,
    entra_user_id:
      typeof r.entra_user_id === "string" ? r.entra_user_id : null,
    is_active: r.is_active === true,
    role: typeof r.role === "string" ? r.role : null,
    app_roles,
  }
}

/**
 * Maps a directory record to a PM role. Internal Hines Homes people are PM
 * 'staff' by default. An explicit app_roles.pm override can demote
 * ('client' / 'trade') or deny ('none' / 'disabled' / 'denied' → null).
 */
export function mapDirectoryToPmRole(rec: DirectoryRecord): PmRole | null {
  const override = rec.app_roles?.[PM_APP_KEY]?.trim().toLowerCase()
  if (override === "none" || override === "disabled" || override === "denied") {
    return null
  }
  if (override === "client") return "client"
  if (override === "trade") return "trade"
  return "staff"
}
