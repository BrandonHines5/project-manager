import { requireSession } from "@/lib/auth"
import { Topbar } from "@/components/layout/topbar"
import { SectionTabs } from "@/components/layout/section-tabs"
import { ProjectContextShell } from "@/components/layout/project-context-shell"
import { ProjectListSidebar } from "@/components/layout/project-list-sidebar"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { HINES_HOMES, brandForProjectTypes } from "@/lib/brand"

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
  const [{ count: unreadCount }, { data: projects }] = await Promise.all([
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
  ])

  // Client-facing branding: a client whose projects are all commercial sees
  // MJV Building Group across the app; everyone else (staff/trade, or a client
  // with any residential job) sees the default Hines Homes brand.
  const brand =
    profile.role === "client"
      ? brandForProjectTypes((projects ?? []).map((p) => p.project_type))
      : HINES_HOMES

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
      />
      <SectionTabs role={profile.role} />
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
          className="flex-1 min-w-0 overflow-y-auto"
        >
          {children}
        </main>
      </ProjectContextShell>
    </div>
  )
}
