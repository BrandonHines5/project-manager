import "server-only"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId, NoActiveOrgError } from "@/lib/org"
import {
  FEATURE_DEFS,
  getOrgFeatures,
  type FeatureKey,
} from "@/lib/features"

/**
 * Server-action guard for gated features — the enforcement half of the nav
 * hiding (hiding a tab isn't enforcement; a crafted action call must fail).
 * One line at the top of a gated mutation, the assertActiveOrgWritable
 * pattern:
 *
 *   await requireOrgFeature("bid_requests")
 *
 * Checks the CALLER's active org, same as the sandbox write-block — a
 * staffer's active org is the org whose records they're acting on. Throws a
 * plain Error with a user-facing message when the feature is off.
 *
 * Failure posture mirrors lib/features.ts: NO-org (clients/trades, the
 * single-tenant bridge) and every resolution error ALLOW the call — gating
 * is a product boundary, not a security one, and a transient read failure
 * must never block a paying builder's work. Only a successfully-resolved
 * plan that lacks the feature blocks.
 */
export async function requireOrgFeature(
  feature: FeatureKey,
  profileId?: string
): Promise<void> {
  if (await hasOrgFeature(feature, profileId)) return
  const label =
    FEATURE_DEFS.find((f) => f.key === feature)?.label ?? "This feature"
  throw new Error(
    `${label} isn't included in your plan. Contact support to upgrade.`
  )
}

/**
 * Non-throwing variant for callers with a typed-error contract (the AI agent
 * actions never throw) and for page-level render checks. Same fail-open
 * posture: only a successfully-resolved plan lacking the feature is false.
 */
export async function hasOrgFeature(
  feature: FeatureKey,
  profileId?: string
): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient()
    const orgId = await getActiveOrgId(supabase, profileId)
    const features = await getOrgFeatures(supabase, orgId)
    return features.has(feature)
  } catch (e) {
    if (!(e instanceof NoActiveOrgError)) {
      console.warn(
        "[features] guard resolution failed (allowing):",
        e instanceof Error ? e.message : e
      )
    }
    return true
  }
}
