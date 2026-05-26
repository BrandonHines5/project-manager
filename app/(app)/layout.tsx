import { requireSession } from "@/lib/auth"
import { Sidebar } from "@/components/layout/sidebar"
import { Topbar } from "@/components/layout/topbar"
import { ProjectContextShell } from "@/components/layout/project-context-shell"
import { ProjectListSidebar } from "@/components/layout/project-list-sidebar"
import { createSupabaseServerClient } from "@/lib/supabase/server"

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
      .select("id, name, project_number, address, status")
      .order("project_number", { ascending: false }),
  ])

  return (
    <div className="flex min-h-screen flex-1">
      <Sidebar role={profile.role} />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          fullName={profile.full_name}
          email={profile.email ?? ""}
          role={profile.role}
          unreadCount={unreadCount ?? 0}
        />
        <ProjectContextShell
          sidebar={<ProjectListSidebar projects={projects ?? []} />}
        >
          <main className="flex-1 overflow-y-auto">{children}</main>
        </ProjectContextShell>
      </div>
    </div>
  )
}
