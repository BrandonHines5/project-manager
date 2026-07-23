import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { isLegacyOrgOwner } from "@/lib/org"
import { isFeatureKey, type FeatureKey } from "@/lib/features"
import { FeatureAccessClient, type PlanRow, type OrgRow } from "./features-client"

export const metadata = { title: "Feature access — BuildFox" }
export const dynamic = "force-dynamic"

/**
 * Platform-operator surface (0122): define access levels (which features each
 * level includes) and assign organizations to levels. The REAL gate is the
 * legacy-org-owner check inside every app/actions/platform.ts action — this
 * page just renders the notice for anyone else. Reads use the ADMIN client
 * because the operator isn't a member of the tenant orgs being listed.
 */
export default async function FeatureAccessPage() {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  if (!(await isLegacyOrgOwner(supabase, profile.id))) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">Feature access</h1>
        <p className="mt-2 text-sm text-muted">
          Only the platform owner can manage feature access.
        </p>
      </div>
    )
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">Feature access</h1>
        <p className="mt-2 text-sm text-muted">Server storage is not configured.</p>
      </div>
    )
  }

  const [{ data: planRows }, { data: orgRows }] = await Promise.all([
    admin
      .from("platform_plans")
      .select("key, name, features, position")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("organizations")
      .select("id, name, slug, status, plan")
      .order("name", { ascending: true }),
  ])

  const plans: PlanRow[] = (planRows ?? []).map((p) => ({
    key: p.key,
    name: p.name,
    features: (Array.isArray(p.features) ? p.features : []).filter(
      (f): f is FeatureKey => isFeatureKey(f)
    ),
  }))
  const orgs: OrgRow[] = (orgRows ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    plan: o.plan,
  }))

  return <FeatureAccessClient plans={plans} orgs={orgs} />
}
