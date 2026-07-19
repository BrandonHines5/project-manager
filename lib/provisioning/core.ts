import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { LEGACY_ORG_ID } from "@/lib/org"
import { generateTempPassword } from "@/lib/auth/temp-password"

// Shared org-provisioning core. Both the operator UI (provisionOrganization,
// a staff server action gated to the legacy-org owner) and the public
// self-serve trial route (/api/trial/signup, gated by a shared secret + rate
// limit) stand up an org exactly the same way — create the owner's auth user,
// promote to staff, create the org seeded from Hines, land the owner in it —
// differing only in lifecycle (full subscriber vs a time-boxed sandbox trial).
// That common sequence lives here so neither call site duplicates the
// createUser → promote → RPC → rollback dance. The TRUST decision (who may
// provision) stays at each call site; this core assumes inputs are validated
// and the caller is authorized.

export type ProvisionLifecycle = "active_subscriber" | "sandbox_active"

export type ProvisionOrgCoreInput = {
  orgName: string
  slug: string
  ownerName: string
  ownerEmail: string
  lifecycle: ProvisionLifecycle
  /** Trial length; used only when lifecycle is 'sandbox_active'. Default 7. */
  trialDays?: number
}

export type ProvisionOrgCoreResult =
  | {
      ok: true
      orgId: string
      ownerEmail: string
      /** One-time temp password — the caller delivers it; never round-trips the browser. */
      tempPassword: string
      /** ISO expiry when lifecycle is 'sandbox_active', else null. */
      sandboxExpiresAt: string | null
    }
  | { ok: false; error: string }

const DEFAULT_TRIAL_DAYS = 7

/**
 * Stand up a brand-new builder org end to end (see module comment). Any failure
 * after the auth user is created rolls it back (deleting the auth user cascades
 * its profile + membership) so a retry starts clean. The org itself is created
 * by a single SECURITY DEFINER RPC — create_organization for a full subscriber,
 * or create_sandbox_organization (which stamps the trial status atomically) for
 * a sandbox — so a created org always carries the right lifecycle; there's no
 * half-provisioned "free forever" state to unwind.
 *
 * The caller supplies the admin (service-role) client since it also owns the
 * gate and often needs the client for its own steps.
 */
export async function provisionOrgCore(
  admin: SupabaseClient<Database>,
  input: ProvisionOrgCoreInput
): Promise<ProvisionOrgCoreResult> {
  const { orgName, slug, ownerName, ownerEmail, lifecycle } = input
  const tempPassword = generateTempPassword()

  // 1. Owner auth user. handle_new_user inserts a role='client' profile.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: ownerName },
  })
  if (createErr) {
    const taken = /already been registered|already exists|duplicate/i.test(
      createErr.message
    )
    return {
      ok: false,
      error: taken
        ? "That email already has an account — use a different owner email."
        : createErr.message,
    }
  }
  const ownerId = created.user?.id
  if (!ownerId) return { ok: false, error: "createUser returned no user id." }

  // Roll the auth user back (cascades its profile + any org membership) so a
  // failure leaves nothing half-provisioned. If the rollback ITSELF fails, log
  // the orphaned auth-user id + raw error server-side (this core now backs the
  // PUBLIC /api/trial/signup route, so that detail must reach the team's logs,
  // not the external caller's response) and return only the caller-safe message.
  const rollback = async (message: string): Promise<ProvisionOrgCoreResult> => {
    const { error: delErr } = await admin.auth.admin.deleteUser(ownerId)
    if (delErr) {
      console.error(
        `[provision] orphaned auth user ${ownerId} — rollback cleanup failed: ${delErr.message}`
      )
    }
    return { ok: false, error: message }
  }

  // 2. Promote to staff.
  const { error: roleErr } = await admin
    .from("profiles")
    .update({ role: "staff", full_name: ownerName })
    .eq("id", ownerId)
  if (roleErr) {
    return rollback(`Couldn't set up the owner profile: ${roleErr.message}`)
  }

  // 3. Create the org (+ enroll owner, seed catalogs from Hines) in one
  // transaction. The sandbox variant also stamps status + expiry atomically.
  let orgId: string
  let sandboxExpiresAt: string | null = null

  if (lifecycle === "sandbox_active") {
    const trialDays = input.trialDays ?? DEFAULT_TRIAL_DAYS
    const { data, error: rpcErr } = await admin.rpc(
      "create_sandbox_organization",
      { p_name: orgName, p_slug: slug, p_owner: ownerId, p_trial_days: trialDays }
    )
    if (rpcErr) return rollback(mapCreateOrgError(rpcErr))
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.org_id) {
      return rollback("create_sandbox_organization returned no id.")
    }
    orgId = row.org_id
    sandboxExpiresAt = row.expires_at ?? null
  } else {
    const { data: newOrgId, error: rpcErr } = await admin.rpc(
      "create_organization",
      {
        p_name: orgName,
        p_slug: slug,
        p_owner: ownerId,
        p_seed_from: LEGACY_ORG_ID,
      }
    )
    if (rpcErr) return rollback(mapCreateOrgError(rpcErr))
    if (!newOrgId) return rollback("create_organization returned no id.")
    orgId = newOrgId as string
  }

  // 4. Land the owner in their new org on first login. Non-fatal: getActiveOrgId
  // falls back to the earliest membership, which is this org anyway.
  const { error: activeErr } = await admin
    .from("profiles")
    .update({ active_org_id: orgId })
    .eq("id", ownerId)
  if (activeErr) {
    console.warn("[provision] active_org_id set failed:", activeErr.message)
  }

  return { ok: true, orgId, ownerEmail, tempPassword, sandboxExpiresAt }
}

/**
 * Both create RPCs surface a slug collision as the organizations_slug_key unique
 * violation (create_sandbox_organization calls create_organization). Only that
 * maps to the friendly "taken" message — a generic unique/duplicate match would
 * mislabel any OTHER failure (e.g. a seeded cost-code/role constraint) as a slug
 * problem, which it isn't.
 */
function mapCreateOrgError(err: { message: string; code?: string }): string {
  const slugTaken =
    /organizations_slug_key/i.test(err.message) ||
    (err.code === "23505" && /\bslug\b/i.test(err.message))
  return slugTaken
    ? "That URL slug is already taken — pick another."
    : `Couldn't create the organization: ${err.message}`
}
