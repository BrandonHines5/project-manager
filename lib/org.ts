import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

/**
 * Pure active-org resolution, shared by getActiveOrgId and callers that
 * already hold the membership list (the app layout): the stored selection
 * wins when it names one of the caller's memberships, otherwise the earliest
 * membership. A stale selection (membership revoked) silently falls back.
 */
export function resolveActiveOrgId(
  selected: string | null | undefined,
  memberships: { org_id: string }[]
): string | null {
  if (selected && memberships.some((m) => m.org_id === selected)) {
    return selected
  }
  return memberships[0]?.org_id ?? null
}

/**
 * The acting user's organization id, read through their RLS session. Insert
 * paths for org-scoped tables must stamp org_id with this — the 0099 bridge
 * defaults are dropped module by module as inserts become org-aware
 * (docs/multi-tenant-plan.md).
 *
 * Resolution (B5): `profiles.active_org_id` wins when it names one of the
 * caller's own organization_members rows (the avatar-menu switcher sets it);
 * otherwise the earliest membership — which is exactly the pre-B5 behavior
 * for every single-org user. A stale selection (membership revoked) silently
 * falls back rather than erroring.
 *
 * `profileId` is optional plumbing: call sites that already resolved the
 * session profile pass it to skip the auth.getUser() round trip; without it
 * the user id is resolved here.
 */
export async function getActiveOrgId(
  supabase: SupabaseClient<Database>,
  profileId?: string
): Promise<string> {
  let uid = profileId
  if (!uid) {
    const { data: auth } = await supabase.auth.getUser()
    uid = auth?.user?.id
  }
  if (!uid) {
    throw new Error("Your account isn't a member of any organization.")
  }

  // org_members_member_read exposes every membership row of the caller's
  // orgs (member lists need that), so filter to the caller's OWN rows.
  const [{ data: prof, error: profErr }, { data: memberships, error }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("active_org_id")
        .eq("id", uid)
        .maybeSingle(),
      supabase
        .from("organization_members")
        .select("org_id")
        .eq("profile_id", uid)
        .order("created_at", { ascending: true }),
    ])
  if (profErr) throw new Error(profErr.message)
  if (error) throw new Error(error.message)

  const orgId = resolveActiveOrgId(prof?.active_org_id, memberships ?? [])
  if (!orgId) {
    throw new Error("Your account isn't a member of any organization.")
  }
  return orgId
}

/**
 * All of the acting user's org memberships, earliest first — powers the org
 * switcher (which only renders when there's more than one).
 */
export async function getOrgMemberships(
  supabase: SupabaseClient<Database>,
  profileId: string
): Promise<{ org_id: string; name: string }[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id, created_at, organizations:org_id(name)")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((m) => ({
    org_id: m.org_id,
    name:
      (m.organizations as unknown as { name: string } | null)?.name ??
      "Organization",
  }))
}
