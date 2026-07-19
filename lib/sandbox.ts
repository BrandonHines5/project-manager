import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId, NoActiveOrgError } from "@/lib/org"

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

/** Thrown by assertActiveOrgWritable when a lapsed trial tries to mutate. */
export class TrialExpiredError extends Error {
  constructor() {
    super(
      "Your trial has ended. Subscribe to keep working in your organization."
    )
    this.name = "TrialExpiredError"
  }
}

/**
 * Mutation guard (S1b): throws `TrialExpiredError` when the CALLER's active org
 * is a lapsed sandbox trial. Because it checks the caller's OWN org — never a
 * target row's — one call at the top of a mutating server action gates every
 * write that user could attempt (create, update, delete, any table), and it
 * can NEVER freeze a non-trial org (an active_subscriber always resolves
 * writable). The paywall's inert shell is the primary block; this is the
 * server-side backstop for anything that bypasses the UI. Reuses
 * resolveOrgLifecycle, so it also performs the lazy expiry flip and fails open.
 */
export async function assertActiveOrgWritable(
  supabase?: SupabaseClient<Database>,
  profileId?: string
): Promise<void> {
  // Self-contained (creates its own session client if none is passed) so it
  // drops in as a single line right after a mutating action's auth guard,
  // regardless of where that action builds its client.
  const client = supabase ?? (await createSupabaseServerClient())
  let orgId: string
  try {
    orgId = await getActiveOrgId(client, profileId)
  } catch (e) {
    // A genuine "no organization" account isn't a sandbox tenant → allow. ANY
    // other failure (auth / profile / membership query error) means we can't
    // verify writability, so a mutation guard must FAIL CLOSED — abort the
    // write rather than let a possibly-expired trial slip through on a hiccup.
    if (e instanceof NoActiveOrgError) return
    throw e
  }
  // Strict, fail-closed status read for the WRITE path — unlike the layout's
  // fail-OPEN resolveOrgLifecycle (which must never paywall a paying customer
  // over a transient read error). We also compute effective expiry, so a trial
  // that lapsed since the last page load — still 'sandbox_active' in the row
  // until the layout's lazy flip runs — is blocked here too.
  const { data: org, error } = await client
    .from("organizations")
    .select("status, sandbox_expires_at")
    .eq("id", orgId)
    .maybeSingle()
  if (error) throw error
  if (!org) throw new Error("Couldn't verify the organization's status.")
  const expired =
    org.status === "sandbox_expired" ||
    (org.status === "sandbox_active" &&
      !!org.sandbox_expires_at &&
      new Date(org.sandbox_expires_at).getTime() <= Date.now())
  if (expired) throw new TrialExpiredError()
}
