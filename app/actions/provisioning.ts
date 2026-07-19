"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { LEGACY_ORG_ID } from "@/lib/org"
import { generateTempPassword } from "@/lib/auth/temp-password"

// Org provisioning (B5 onboarding). Standing up a NEW builder org is the
// SaaS-operator action — distinct from the per-org admin surfaces — so it's
// gated to the OWNER of the legacy (Hines) org, the platform operator today.
// The heavy lifting (org row + owner enrollment + catalog seed) is the
// service-role-only `create_organization` RPC (0111); this action wraps it
// with the one thing it can't do — bootstrap the owner's login — so the whole
// flow is a single UI action instead of manual SQL.

const ProvisionOrgInput = z.object({
  orgName: z.string().trim().min(1, "Organization name is required.").max(120),
  // Mirror create_organization's own slug rule so the error surfaces before
  // we create an auth user we'd have to roll back.
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,62}$/,
      "Slug must be 2–63 chars: lowercase letters, digits, and dashes."
    ),
  ownerName: z.string().trim().min(1, "Owner name is required.").max(200),
  ownerEmail: z.string().trim().email("Enter a valid owner email.").max(200),
})

export type ProvisionOrgInputT = z.infer<typeof ProvisionOrgInput>

export type ProvisionOrgResult =
  | { ok: true; orgId: string; ownerEmail: string; tempPassword: string }
  | { ok: false; error: string }

/**
 * The platform operator = OWNER of the legacy (Hines) org. Read under the
 * caller's own session so RLS proves the membership; a non-owner (or a
 * non-legacy-org staffer) is rejected.
 */
async function isLegacyOrgOwner(profileId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase
    .from("organization_members")
    .select("member_role")
    .eq("org_id", LEGACY_ORG_ID)
    .eq("profile_id", profileId)
    .maybeSingle()
  return data?.member_role === "owner"
}

/**
 * Provision a brand-new builder organization end to end:
 *  1. create the owner's auth user (temp password, returned once to share),
 *  2. promote that profile to staff (admin client — service_role is exempt
 *     from prevent_role_escalation, and the caller doesn't yet share an org
 *     with this user so a session update would be RLS-blocked),
 *  3. run `create_organization` (org row + owner enrolled as 'owner' + active
 *     cost codes/roles seeded from Hines),
 *  4. point the owner's active_org_id at the new org so they land there.
 *
 * Any failure after the auth user is created rolls it back (deleting the auth
 * user cascades the profile) so a retry starts clean. The temp password never
 * round-trips from the client — it's generated server-side and returned once.
 */
export async function provisionOrganization(
  input: ProvisionOrgInputT
): Promise<ProvisionOrgResult> {
  const me = await requireStaff()
  const parsed = ProvisionOrgInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }
  const { orgName, slug, ownerName, ownerEmail } = parsed.data

  if (!(await isLegacyOrgOwner(me.id))) {
    return {
      ok: false,
      error: "Only the platform owner can provision new organizations.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return { ok: false, error: "Server admin (service role) is not configured." }
  }

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
  // failure leaves nothing half-provisioned. Surfaces a compound error if the
  // rollback itself fails, so an orphaned auth user is never silent.
  const rollback = async (message: string): Promise<ProvisionOrgResult> => {
    const { error: delErr } = await admin.auth.admin.deleteUser(ownerId)
    return {
      ok: false,
      error: delErr
        ? `${message} (Cleanup also failed — orphaned auth user ${ownerId}: ${delErr.message})`
        : message,
    }
  }

  // 2. Promote to staff.
  const { error: roleErr } = await admin
    .from("profiles")
    .update({ role: "staff", full_name: ownerName })
    .eq("id", ownerId)
  if (roleErr) {
    return rollback(`Couldn't set up the owner profile: ${roleErr.message}`)
  }

  // 3. Create the org (+ enroll owner, seed catalogs) in one transaction. We
  // always seed cost codes + roles from Hines so the new org starts with a
  // usable catalog the owner can then edit; brands/settings/integrations are
  // deliberately NOT copied (they're configured per-org afterward).
  const { data: newOrgId, error: rpcErr } = await admin.rpc(
    "create_organization",
    {
      p_name: orgName,
      p_slug: slug,
      p_owner: ownerId,
      p_seed_from: LEGACY_ORG_ID,
    }
  )
  if (rpcErr) {
    const dupSlug = /duplicate key|unique|slug/i.test(rpcErr.message)
    return rollback(
      dupSlug
        ? "That URL slug is already taken — pick another."
        : `Couldn't create the organization: ${rpcErr.message}`
    )
  }
  if (!newOrgId) return rollback("create_organization returned no id.")

  // 4. Land the owner in their new org on first login. Non-fatal: getActiveOrgId
  // falls back to the earliest membership, which is this org anyway.
  const { error: activeErr } = await admin
    .from("profiles")
    .update({ active_org_id: newOrgId as string })
    .eq("id", ownerId)
  if (activeErr) {
    console.warn("[provision] active_org_id set failed:", activeErr.message)
  }

  revalidatePath("/", "layout")
  return {
    ok: true,
    orgId: newOrgId as string,
    ownerEmail,
    tempPassword,
  }
}
