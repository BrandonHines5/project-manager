import { Bell } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { EmptyState } from "@/components/ui/empty"
import { formatDate } from "@/lib/utils"
import Link from "next/link"

export const metadata = { title: "Notifications — Hines Homes" }

export default async function NotificationsPage() {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(100)

  // Mark all as read on view
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", profile.id)
    .is("read_at", null)

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-5">Notifications</h1>
      {!notifications || notifications.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-10 w-10" />}
          title="No notifications"
          description="You're all caught up."
        />
      ) : (
        <ul className="bg-surface border border-border rounded-lg divide-y divide-border">
          {notifications.map((n) => (
            <li key={n.id}>
              {n.link_url ? (
                <Link
                  href={n.link_url}
                  className="block px-4 py-3 hover:bg-background/60"
                >
                  <NotificationRow n={n} />
                </Link>
              ) : (
                <div className="px-4 py-3">
                  <NotificationRow n={n} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NotificationRow({
  n,
}: {
  n: {
    title: string
    body: string | null
    created_at: string
  }
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{n.title}</div>
        {n.body && <div className="text-sm text-muted mt-0.5">{n.body}</div>}
      </div>
      <div className="text-xs text-muted whitespace-nowrap">
        {formatDate(n.created_at)}
      </div>
    </div>
  )
}
