import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { NotificationsSettingsClient } from "./notifications-settings-client"

export const metadata = { title: "Notification settings — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function NotificationSettingsPage() {
  const me = await requireSession()
  const supabase = await createSupabaseServerClient()
  const isStaff = me.role === "staff"

  // RLS returns the caller's own rows for everyone; staff additionally see all
  // rows so they can manage other people's and companies' settings.
  const { data: prefRows } = await supabase
    .from("notification_preferences")
    .select("profile_id, company_id, category, channel, enabled")

  let profiles: {
    id: string
    full_name: string | null
    email: string | null
    role: "staff" | "trade" | "client"
  }[] = []
  let companies: { id: string; name: string }[] = []
  if (isStaff) {
    const [profRes, coRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .order("full_name"),
      supabase
        .from("companies")
        .select("id, name")
        .in("type", ["sub", "vendor"])
        .order("name"),
    ])
    if (profRes.error || coRes.error) {
      console.error(
        "[notifications settings] failed to load profiles/companies",
        profRes.error?.message,
        coRes.error?.message
      )
    }
    profiles = (profRes.data ?? []) as typeof profiles
    companies = coRes.data ?? []
  }

  // Flatten to "ownerKey|category|channel" -> enabled. Missing key => enabled.
  const prefs: Record<string, boolean> = {}
  for (const r of prefRows ?? []) {
    const ownerKey = r.profile_id ? `p:${r.profile_id}` : `c:${r.company_id}`
    prefs[`${ownerKey}|${r.category}|${r.channel}`] = r.enabled
  }

  return (
    <NotificationsSettingsClient
      me={{
        id: me.id,
        name: me.full_name || me.email || "You",
        role: me.role,
      }}
      profiles={profiles}
      companies={companies}
      initialPrefs={prefs}
    />
  )
}
