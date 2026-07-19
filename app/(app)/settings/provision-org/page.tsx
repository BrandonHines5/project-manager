import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { isLegacyOrgOwner } from "@/lib/org"
import { ProvisionOrgClient } from "./provision-org-client"

export const metadata = { title: "Provision organization — BuildFox" }
export const dynamic = "force-dynamic"

/**
 * Platform-operator surface (B5 onboarding): stand up a new builder org. The
 * REAL gate is `provisionOrganization`'s legacy-org-owner check + the
 * service-role-only RPC — this page just renders the notice for anyone else,
 * and a forged action call is rejected server-side.
 */
export default async function ProvisionOrgPage() {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  if (!(await isLegacyOrgOwner(supabase, profile.id))) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">
          Provision organization
        </h1>
        <p className="mt-2 text-sm text-muted">
          Only the platform owner can create new organizations.
        </p>
      </div>
    )
  }

  return <ProvisionOrgClient />
}
