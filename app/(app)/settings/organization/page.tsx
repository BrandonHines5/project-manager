import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getActiveOrgId, LEGACY_ORG_ID } from "@/lib/org"
import { getOrgIntegration } from "@/lib/integrations/org"
import { parseBrandConfig } from "@/lib/brand"
import { OrganizationSettingsClient } from "./organization-settings-client"
import {
  OrganizationMembersClient,
  type OrgMemberRow,
} from "./organization-members-client"
import { OrganizationIntegrationsClient } from "./organization-integrations-client"

export const metadata = { title: "Organization — BuildFox" }
export const dynamic = "force-dynamic"

export default async function OrganizationSettingsPage() {
  // Staff-only surface; the REAL write gate is the 0108 orgs_admin_update
  // policy (+ the brand-assets storage policy) — a non-admin who lands here
  // just gets the notice below, and a forged action call updates zero rows.
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)

  const [{ data: membership }, { data: org }, { data: memberRows }] =
    await Promise.all([
      supabase
        .from("organization_members")
        .select("member_role")
        .eq("org_id", orgId)
        .eq("profile_id", profile.id)
        .maybeSingle(),
      supabase
        .from("organizations")
        .select("id, name, settings")
        .eq("id", orgId)
        .maybeSingle(),
      // Whole-org roster (org_members_member_read); profile details ride the
      // FK embed — co-members are readable via shares_org_with (0105).
      supabase
        .from("organization_members")
        .select("profile_id, member_role, profiles:profile_id(full_name, email)")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
    ])

  const isAdmin =
    membership?.member_role === "owner" || membership?.member_role === "admin"
  if (!isAdmin || !org) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">Organization</h1>
        <p className="mt-2 text-sm text-muted">
          Only organization owners and admins can edit these settings. Ask an
          owner if something here needs to change.
        </p>
      </div>
    )
  }

  // The editor shows the EFFECTIVE brands (parse fallbacks included) so the
  // preview matches what users see; saveOrgSettings keeps untouched slots
  // from the raw stored config, so displaying fallbacks never bakes them in.
  // Quo integration status — read admin-side (org_integrations is
  // service-role-only) but only AFTER the owner/admin gate above. The API
  // key never reaches the client: we pass a boolean + the non-secret number.
  // A decrypt failure surfaces as an error banner, never a crash.
  let quoConnected = false
  let quoSharedFrom = ""
  let quoError = false
  const admin = createSupabaseAdminClient()
  if (admin) {
    try {
      const integ = await getOrgIntegration(admin, orgId, "quo")
      quoConnected = Boolean(integ?.enabled && integ.secrets?.apiKey)
      const sf = integ?.config?.sharedFromNumber
      quoSharedFrom = typeof sf === "string" ? sf : ""
    } catch {
      quoError = true
    }
  }
  // The legacy (Hines) org keeps working off env QUO_API_KEY even with no
  // row — surface that so the editor doesn't imply it's disconnected.
  const quoEnvFallback = orgId === LEGACY_ORG_ID && !!process.env.QUO_API_KEY

  const config = parseBrandConfig(org.settings, org.name)
  const members: OrgMemberRow[] = (memberRows ?? []).map((m) => ({
    profile_id: m.profile_id,
    member_role: m.member_role as OrgMemberRow["member_role"],
    full_name:
      (m.profiles as unknown as { full_name: string | null } | null)
        ?.full_name ?? null,
    email:
      (m.profiles as unknown as { email: string | null } | null)?.email ??
      null,
  }))
  return (
    <>
      <OrganizationSettingsClient
        orgId={org.id}
        initialName={org.name}
        initialDefault={{
          name: config.default.name,
          logo: config.default.logo,
          icon: config.default.icon,
        }}
        initialCommercial={
          config.commercial
            ? {
                name: config.commercial.name,
                logo: config.commercial.logo,
                icon: config.commercial.icon,
              }
            : null
        }
      />
      <div className="max-w-2xl mx-auto px-4 md:px-6 pb-6 space-y-4">
        <OrganizationMembersClient
          orgId={org.id}
          callerId={profile.id}
          callerRole={membership.member_role as OrgMemberRow["member_role"]}
          members={members}
        />
        <OrganizationIntegrationsClient
          orgId={org.id}
          quoConnected={quoConnected}
          quoSharedFrom={quoSharedFrom}
          quoError={quoError}
          quoEnvFallback={quoEnvFallback}
        />
      </div>
    </>
  )
}
