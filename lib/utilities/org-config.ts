import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

// Org-owned utility-provider configuration (Stage B3 part 2). Everything here
// used to be hardcoded Hines constants in lib/utilities/{caw,lumber-one}/
// config.ts; it now lives in `organizations.settings.utilities` (seeded for
// org #1 by migration 0107) so the Utilities module is per-org: an org
// without a utilities block simply doesn't have the module — the page renders
// its not-configured state and the actions refuse to send.
//
// What stays in code: form option enums, CAW_FIXED / CAW_DEFAULTS, and the
// meter-size prompt threshold (product behavior, not org identity), plus the
// provider intake FALLBACKS below — CAW and Lumber One are regional providers
// whose intake addresses are provider facts, not org data. Builder identity
// has no fallback: it only ever comes from the org's own settings.
//
// Secrets: the builder TIN prefers the settings value but falls back to the
// CAW_BUILDER_TIN env var, which is where Hines keeps it today — so the seed
// can leave it blank without changing behavior. Same pattern for the
// env-overridable intake emails / payment URL.

export type UtilityBuilder = {
  companyName: string
  tin: string
  businessPhone: string
  altPhone: string
  email: string
  mailingAddress: string
  preparerName: string
}

export type UtilityOrgConfig = {
  builder: UtilityBuilder
  caw: {
    submissionEmail: string
    paymentUrl: string
    zipBySubdivision: Record<string, string>
    zipByCity: Record<string, string>
  }
  lumberOne: {
    submissionEmail: string
    countyByCity: Record<string, string>
    deliveryNoteBySubdivision: Record<string, string>
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** Validate a JSON object into a lowercase-keyed string→string lookup map. */
function rec(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k.trim().toLowerCase()] = val
  }
  return out
}

/**
 * Parse `organizations.settings` into the utilities config, or null when the
 * org has no utilities block at all (module hidden for that org).
 */
export function parseUtilityConfig(settings: unknown): UtilityOrgConfig | null {
  const u =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).utilities
      : null
  if (!u || typeof u !== "object" || Array.isArray(u)) return null
  const o = u as Record<string, unknown>
  const b = (o.builder ?? {}) as Record<string, unknown>
  const c = (o.caw ?? {}) as Record<string, unknown>
  const l = (o.lumberOne ?? {}) as Record<string, unknown>
  return {
    builder: {
      companyName: str(b.companyName),
      tin: str(b.tin) || process.env.CAW_BUILDER_TIN || "",
      businessPhone: str(b.businessPhone),
      altPhone: str(b.altPhone),
      email: str(b.email),
      mailingAddress: str(b.mailingAddress),
      preparerName: str(b.preparerName),
    },
    caw: {
      submissionEmail:
        str(c.submissionEmail) ||
        process.env.CAW_SUBMISSION_EMAIL ||
        "NewConstruction@carkw.com",
      paymentUrl:
        str(c.paymentUrl) ||
        process.env.CAW_PAYMENT_URL ||
        "PLACEHOLDER_CAW_PAYMENT_URL",
      zipBySubdivision: rec(c.zipBySubdivision),
      zipByCity: rec(c.zipByCity),
    },
    lumberOne: {
      submissionEmail:
        str(l.submissionEmail) ||
        process.env.LUMBER_ONE_SUBMISSION_EMAIL ||
        "bhartwick@lumber1.com",
      countyByCity: rec(l.countyByCity),
      deliveryNoteBySubdivision: rec(l.deliveryNoteBySubdivision),
    },
  }
}

/**
 * The acting org's utility config. Works with the session client (the module
 * is staff-only and orgs_member_read covers the caller's own org). Null =
 * the org doesn't have the Utilities module.
 */
export async function getUtilityConfig(
  client: SupabaseClient<Database>,
  orgId: string | null | undefined
): Promise<UtilityOrgConfig | null> {
  if (!orgId) return null
  const { data, error } = await client
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle()
  if (error || !data) return null
  return parseUtilityConfig(data.settings)
}

/** Whether enough is configured to EMAIL a valid application to CAW. Not
 * gated on the TIN (CAW doesn't require it for a business account) or the
 * payment URL (only used later, at the awaiting_payment step). */
export function isCawConfigured(cfg: UtilityOrgConfig): boolean {
  const b = cfg.builder
  const builderReady = [
    b.companyName,
    b.businessPhone,
    b.email,
    b.mailingAddress,
    b.preparerName,
  ].every((v) => v.length > 0 && !v.startsWith("PLACEHOLDER_"))
  return builderReady && !cfg.caw.submissionEmail.startsWith("PLACEHOLDER_")
}

/** Whether enough is configured to email a valid form to Lumber One. */
export function isLumberOneConfigured(cfg: UtilityOrgConfig): boolean {
  return (
    cfg.builder.companyName.length > 0 &&
    !cfg.builder.companyName.startsWith("PLACEHOLDER_") &&
    cfg.lumberOne.submissionEmail.includes("@")
  )
}

const normalizeKey = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase()

/**
 * Resolve a ZIP from subdivision (preferred) or city. Returns undefined when
 * neither is known, so callers leave the field blank rather than guessing.
 */
export function resolveCawZip(
  cfg: UtilityOrgConfig,
  input: { subdivision?: string | null; city?: string | null }
): string | undefined {
  const bySub = cfg.caw.zipBySubdivision[normalizeKey(input.subdivision)]
  if (bySub) return bySub
  const byCity = cfg.caw.zipByCity[normalizeKey(input.city)]
  if (byCity) return byCity
  return undefined
}

/** Resolve the county from the job's city; undefined when unknown. */
export function resolveCounty(
  cfg: UtilityOrgConfig,
  city: string | null | undefined
): string | undefined {
  return cfg.lumberOne.countyByCity[normalizeKey(city)]
}

/** Standing delivery note for a subdivision ("" when there is none). */
export function defaultDeliveryDirections(
  cfg: UtilityOrgConfig,
  subdivision: string | null | undefined
): string {
  return cfg.lumberOne.deliveryNoteBySubdivision[normalizeKey(subdivision)] ?? ""
}
