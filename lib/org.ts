import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

/**
 * Org #1 (Hines Homes) — the pre-multi-tenant tenant. Shared inbound
 * channels that predate per-org addressing (untagged insurance email) file
 * here until every channel carries an org tag; new code must not reach for
 * this outside those legacy funnels.
 */
export const LEGACY_ORG_ID = "018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10"

/**
 * Thrown by getActiveOrgId ONLY for the genuine "this account belongs to no
 * organization" case — never for operational failures (auth/query errors),
 * which keep throwing plain Errors. Lets a caller (e.g. the sandbox write
 * guard) distinguish "not a tenant, allow" from "couldn't verify, fail closed".
 */
export class NoActiveOrgError extends Error {
  constructor() {
    super("Your account isn't a member of any organization.")
    this.name = "NoActiveOrgError"
  }
}

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
    const { data: auth, error: authErr } = await supabase.auth.getUser()
    // Propagate real auth failures — an outage must not masquerade as
    // "you're not in any organization".
    if (authErr) throw new Error(authErr.message)
    uid = auth?.user?.id
  }
  if (!uid) {
    // Unauthenticated — a DIFFERENT case from "authenticated but not in any
    // org". Keep it a plain auth error so guards that treat NoActiveOrgError
    // as an allow-path (assertActiveOrgWritable) fail CLOSED for anon callers.
    throw new Error("Not authenticated.")
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
    throw new NoActiveOrgError()
  }
  return orgId
}

/**
 * Whether the caller is the OWNER of the legacy (Hines) org — the platform
 * operator who can provision new organizations (B5). Read through the given
 * RLS session, so it's the single source of truth for both the
 * `/settings/provision-org` page gate and `provisionOrganization`'s
 * server-side re-check; a non-owner (or non-legacy-org staffer) is false.
 */
export async function isLegacyOrgOwner(
  supabase: SupabaseClient<Database>,
  profileId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("organization_members")
    .select("member_role")
    .eq("org_id", LEGACY_ORG_ID)
    .eq("profile_id", profileId)
    .maybeSingle()
  return data?.member_role === "owner"
}

/**
 * Whether the caller's ACTIVE org is the legacy (Hines) org. This is the gate
 * for Hines-only integrations that are wired to global env creds pointing at
 * Hines' OWN external systems — the CRM ("the dashboard" status source), the
 * outbound dashboard webhook, and the SpecMagician item catalog. For any other
 * org those must NOT fire: reading them pulls Hines' data into another tenant,
 * and firing the webhook ships another tenant's data to Hines' dashboard. So a
 * Hines-only entry point guards on this first. Fails CLOSED — a missing or
 * unresolvable active org resolves to false, so an uncertain context never
 * reaches Hines' infra. (Hines itself always resolves true, so its behavior is
 * unchanged.)
 */
export async function isLegacyActiveOrg(
  supabase: SupabaseClient<Database>,
  profileId?: string
): Promise<boolean> {
  try {
    return (await getActiveOrgId(supabase, profileId)) === LEGACY_ORG_ID
  } catch {
    return false
  }
}

export type OrgMembership = {
  org_id: string
  name: string
  /** Owner/admin unlock /settings/organization. */
  member_role: "owner" | "admin" | "member"
}

/**
 * All of the acting user's org memberships, earliest first — powers the org
 * switcher (which only renders when there's more than one) and the org-admin
 * gate on the Organization settings link.
 */
export async function getOrgMemberships(
  supabase: SupabaseClient<Database>,
  profileId: string
): Promise<OrgMembership[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id, member_role, created_at, organizations:org_id(name)")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((m) => ({
    org_id: m.org_id,
    // The column is text; values are service-role-written from this set.
    member_role: m.member_role as OrgMembership["member_role"],
    name:
      (m.organizations as unknown as { name: string } | null)?.name ??
      "Organization",
  }))
}
