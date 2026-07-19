import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

// Sandbox / trial org lifecycle (S1). A self-serve trial (S2) mints orgs as
// 'sandbox_active' with a 7-day sandbox_expires_at; once past that they're
// 'sandbox_expired' — frozen read-only behind a paywall until they subscribe
// (S3). The flip is LAZY (on read, here) so access gates the instant the trial
// lapses without waiting for a cron; the S4 cron only handles the eventual
// hard delete. Every non-trial org is 'active_subscriber' and never touched.

export type OrgLifecycle =
  | "sandbox_active"
  | "sandbox_expired"
  | "active_subscriber"

/**
 * The effective lifecycle status of the caller's active org, flipping an
 * elapsed trial to 'sandbox_expired' as a side effect. The status is read
 * through the caller's session (a member can read their own org row, same as
 * branding does); the rare flip runs on the admin client with a
 * compare-and-swap on 'sandbox_active' so it can't clobber a concurrent
 * subscribe. Fails OPEN — any error resolves to 'active_subscriber' so a DB
 * hiccup can never paywall a paying customer.
 */
export async function resolveOrgLifecycle(
  supabase: SupabaseClient<Database>,
  orgId: string | null | undefined
): Promise<OrgLifecycle> {
  if (!orgId) return "active_subscriber"
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("status, sandbox_expires_at")
      .eq("id", orgId)
      .maybeSingle()
    if (error || !data) return "active_subscriber"

    const status = data.status as OrgLifecycle
    const expired =
      status === "sandbox_active" &&
      !!data.sandbox_expires_at &&
      new Date(data.sandbox_expires_at).getTime() <= Date.now()

    if (!expired) return status

    // Trial lapsed — record the flip (best-effort; we treat them as expired for
    // this render regardless). CAS on the prior status so a subscribe that
    // landed in the same instant (→ active_subscriber) isn't overwritten.
    const admin = createSupabaseAdminClient()
    if (admin) {
      await admin
        .from("organizations")
        .update({ status: "sandbox_expired" })
        .eq("id", orgId)
        .eq("status", "sandbox_active")
    }
    return "sandbox_expired"
  } catch {
    return "active_subscriber"
  }
}
