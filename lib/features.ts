import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

// Feature gating (0122). The CATALOG of gateable features lives here in code;
// which features each access level (plan) includes lives in `platform_plans`
// (operator-edited at /settings/features); which level an org is on lives in
// `organizations.plan` (+ per-org `feature_overrides` exceptions).
//
// Code only ever asks "does this org have feature X" — never "is this org on
// plan Y" — so repackaging levels is a data change, not a code sweep.
//
// FAIL-OPEN posture everywhere: gating is a product/pricing boundary, not a
// security boundary (RLS owns security). An unreadable plan, a deleted row,
// or a query error must never lobotomize a tenant — resolution degrades to
// ALL features, mirroring resolveOrgLifecycle. The 'internal' plan (Hines,
// operator-provisioned orgs, and the column default for new signups) is
// special-cased to always resolve to everything, overrides ignored.
//
// This file is client-safe (type-only imports): FEATURE_DEFS renders in the
// operator UI and nav components; the async resolver takes a passed client.

export const FEATURE_DEFS = [
  {
    key: "ai_assistant",
    label: "AI assistant",
    description:
      "The AI chat assistant, dictated field notes, and the OnsiteIQ walkthrough.",
  },
  {
    key: "bid_requests",
    label: "Bid requests",
    description: "Bid packages — invite subs, collect quotes, award work.",
  },
  {
    key: "purchase_orders",
    label: "Purchase orders",
    description:
      "POs — release to subs for signature, track committed costs.",
  },
  {
    key: "budget",
    label: "Budget",
    description:
      "The per-job Budget tab: cost-code budgets, actuals, and forecasts.",
  },
  {
    key: "client_invoices",
    label: "Client invoices",
    description:
      "The Invoices tab mirroring QuickBooks invoices and pay links into the portal.",
  },
  {
    key: "vendor_documents",
    label: "Vendor documents",
    description:
      "Insurance certificate / W9 / SMA tracking, auto-ingestion, and expiry reminders.",
  },
] as const

export type FeatureKey = (typeof FEATURE_DEFS)[number]["key"]

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = FEATURE_DEFS.map(
  (f) => f.key
)

/** The seeded always-everything plan (column default; Hines sits here). */
export const INTERNAL_PLAN = "internal"

export function isFeatureKey(v: unknown): v is FeatureKey {
  return (
    typeof v === "string" && (ALL_FEATURE_KEYS as readonly string[]).includes(v)
  )
}

/**
 * Pure resolution: a plan's stored feature list + the org's overrides → the
 * effective feature set. 'internal' (or an unreadable list) = everything.
 * Overrides are a { feature_key: boolean } object — true grants a feature the
 * plan lacks, false revokes one it has — and are IGNORED for 'internal' so
 * the operator's own orgs can never be accidentally restricted.
 */
export function resolveFeatures(
  plan: string | null | undefined,
  planFeatures: unknown,
  overrides: unknown
): Set<FeatureKey> {
  if (!plan || plan === INTERNAL_PLAN || !Array.isArray(planFeatures)) {
    return new Set(ALL_FEATURE_KEYS)
  }
  const set = new Set(planFeatures.filter(isFeatureKey))
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (!isFeatureKey(k)) continue
      if (v === true) set.add(k)
      else if (v === false) set.delete(k)
    }
  }
  return set
}

/**
 * The effective feature set for one org, read through the given client (the
 * session client works: org members read their organizations row, and
 * platform_plans is authenticated-read). A null orgId (client/trade sessions,
 * the single-tenant bridge) and every error path resolve to ALL features —
 * see the fail-open note above.
 */
export async function getOrgFeatures(
  supabase: SupabaseClient<Database>,
  orgId: string | null | undefined
): Promise<Set<FeatureKey>> {
  if (!orgId) return new Set(ALL_FEATURE_KEYS)
  try {
    // One round trip: the plan's feature list rides the organizations read
    // via the organizations.plan → platform_plans FK embed (a to-one embed —
    // object, not array). This path runs on every authed layout render.
    const { data: org, error } = await supabase
      .from("organizations")
      .select("plan, feature_overrides, platform_plans(features)")
      .eq("id", orgId)
      .maybeSingle()
    if (error || !org) {
      if (error) console.warn("[features] org read failed:", error.message)
      return new Set(ALL_FEATURE_KEYS)
    }
    if (!org.plan || org.plan === INTERNAL_PLAN) return new Set(ALL_FEATURE_KEYS)
    return resolveFeatures(
      org.plan,
      org.platform_plans?.features,
      org.feature_overrides
    )
  } catch (e) {
    console.warn(
      "[features] resolution failed:",
      e instanceof Error ? e.message : e
    )
    return new Set(ALL_FEATURE_KEYS)
  }
}
