import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId } from "@/lib/org"
import { parseBrandConfig } from "@/lib/brand"
import { OrganizationSettingsClient } from "./organization-settings-client"

export const metadata = { title: "Organization — BuildFox" }
export const dynamic = "force-dynamic"

export default async function OrganizationSettingsPage() {
  // Staff-only surface; the REAL write gate is the 0108 orgs_admin_update
  // policy (+ the brand-assets storage policy) — a non-admin who lands here
  // just gets the notice below, and a forged action call updates zero rows.
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)

  const [{ data: membership }, { data: org }] = await Promise.all([
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
  const config = parseBrandConfig(org.settings, org.name)
  return (
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
  )
}
