import { requireSession } from "@/lib/auth"
import { Topbar } from "@/components/layout/topbar"
import { SectionTabs } from "@/components/layout/section-tabs"
import { ProjectContextShell } from "@/components/layout/project-context-shell"
import { ProjectListSidebar } from "@/components/layout/project-list-sidebar"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { brandForProjectTypes } from "@/lib/brand"
import { getBrandConfig } from "@/lib/org-brand"
import { getOrgMemberships, resolveActiveOrgId, LEGACY_ORG_ID } from "@/lib/org"

// Every authenticated page depends on cookies and per-user data, so we opt out
// of any caching here — otherwise Vercel's edge can serve one user's response
// (or the unauthenticated redirect HTML) to another visitor.
export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  // Both queries are RLS-scoped; trades / clients only see projects they're a
  // member of. We fetch the project list here (not in each page) so the
  // sidebar stays consistent across navigations and benefits from React's
  // server-component dedupe.
  const [{ count: unreadCount }, { data: projects }, orgsResult] =
    await Promise.all([
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", profile.id)
        .is("read_at", null),
      supabase
        .from("projects")
        .select(
          "id, name, project_number, address, status, crm_status, project_type, labels"
        )
        .order("project_number", { ascending: false }),
      // Org membership is independent of the other two — ride the same batch.
      // A failed read is NOT "no memberships": keep the failure distinct so a
      // transient DB hiccup degrades (switcher hidden this render, branding
      // from the stored selection) instead of masquerading as an empty state
      // — while never blanking the whole shell over a sidebar affordance.
      getOrgMemberships(supabase, profile.id).then(
        (orgs) => ({ ok: true as const, orgs }),
        (err: unknown) => ({ ok: false as const, err })
      ),
    ])

  if (!orgsResult.ok) {
    console.error("[layout] org membership read failed:", orgsResult.err)
  }
  const orgs = orgsResult.ok ? orgsResult.orgs : []

  // Same resolution as getActiveOrgId (shared resolveActiveOrgId helper), but
  // from data already in hand — the session profile carries active_org_id and
  // `orgs` IS the membership list, so the layout skips the duplicate
  // organization_members read. On a failed membership read, fall back to the
  // stored selection (setActiveOrg validated it at write time) so an existing
  // multi-org user keeps their org's branding through the hiccup.
  const activeOrgId = orgsResult.ok
    ? resolveActiveOrgId(profile.active_org_id, orgs)
    : (profile.active_org_id ?? null)

  // Owner/admin members of the ACTIVE org get the Organization settings link.
  const activeMembership = orgs.find((o) => o.org_id === activeOrgId)
  const orgAdmin =
    activeMembership?.member_role === "owner" ||
    activeMembership?.member_role === "admin"

  // The platform operator (owner of the legacy Hines org) gets the
  // "Provision organization" link — standing up new tenants is their job.
  const platformAdmin = orgs.some(
    (o) => o.org_id === LEGACY_ORG_ID && o.member_role === "owner"
  )

  // Org-driven branding (B3): the workspace presents the caller's org. A
  // client whose projects are all commercial sees the org's commercial
  // sub-brand across the app; everyone else (staff/trade, or a client with
  // any residential job) sees the org's default brand. getActiveOrgId throws
  // only for a user with no org membership, which requireSession-passing
  // users always have (0105 enrolls at birth) — but don't let a data hiccup
  // blank the shell: fall back to the static default config.
  const brandConfig = await getBrandConfig(supabase, activeOrgId)
  const brand =
    profile.role === "client"
      ? brandForProjectTypes(
          (projects ?? []).map((p) => p.project_type),
          brandConfig
        )
      : brandConfig.default

  // Buildertrend-style shell: dark menu bar on top, section tabs under it,
  // jobs list on the left, and the page content scrolling on its own inside
  // a viewport-height column (so the jobs list and its controls never
  // scroll out of view).
  return (
    <div className="flex h-dvh flex-col">
      {/* Skip-to-main: invisible until focused. Keyboard users hit Tab on
          load and get a way to bypass the topbar / jobs-list nav. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-brand-500 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      >
        Skip to main content
      </a>
      <Topbar
        fullName={profile.full_name}
        email={profile.email ?? ""}
        role={profile.role}
        unreadCount={unreadCount ?? 0}
        brand={brand}
        orgs={orgs}
        activeOrgId={activeOrgId}
        orgAdmin={orgAdmin}
        platformAdmin={platformAdmin}
        // The jobs-list sidebar is desktop-only; the topbar hands the same
        // list to the mobile drawer so phones can switch jobs too.
        projects={projects ?? []}
      />
      <SectionTabs
        role={profile.role}
        financialAccess={profile.role === "staff" && !!profile.financial_access}
      />
      <ProjectContextShell
        sidebar={
          <ProjectListSidebar
            projects={projects ?? []}
            canSync={profile.role === "staff"}
          />
        }
      >
        <main
          id="main-content"
          // Bottom safe-area so the last row of content clears the iPhone
          // home indicator when installed as a home-screen app.
          className="flex-1 min-w-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        >
          {children}
        </main>
      </ProjectContextShell>
    </div>
  )
}
