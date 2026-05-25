import { requireSession } from "@/lib/auth"
import { Sidebar } from "@/components/layout/sidebar"
import { Topbar } from "@/components/layout/topbar"
import { createSupabaseServerClient } from "@/lib/supabase/server"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()
  const { count: unreadCount } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", profile.id)
    .is("read_at", null)

  return (
    <div className="flex min-h-screen flex-1">
      <Sidebar role={profile.role} />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          fullName={profile.full_name}
          email={profile.email}
          role={profile.role}
          unreadCount={unreadCount ?? 0}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
