import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

/**
 * The acting user's organization id, read through their RLS session (their
 * own organization_members rows). Insert paths for org-scoped tables must
 * stamp org_id with this — the 0099 bridge defaults are dropped module by
 * module as inserts become org-aware (docs/multi-tenant-plan.md).
 *
 * Today every user belongs to exactly one org; if multi-org membership ever
 * ships, this picks the first deterministically and the callers gain an org
 * switcher instead.
 */
export async function getActiveOrgId(
  supabase: SupabaseClient<Database>
): Promise<string> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) throw new Error(error.message)
  const orgId = data?.[0]?.org_id
  if (!orgId) {
    throw new Error("Your account isn't a member of any organization.")
  }
  return orgId
}
