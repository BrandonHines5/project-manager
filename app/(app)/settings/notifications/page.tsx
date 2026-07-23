import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { NotificationsSettingsClient } from "./notifications-settings-client"
import { MutedJobsSection } from "@/components/settings/muted-jobs-section"

export const metadata = { title: "Notification settings — BuildFox" }
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

  // Per-job mutes (mine only — muting is personal) + the jobs I can see, for
  // the "Mute a job…" picker. RLS scopes the project list to the caller.
  const [{ data: muteRows }, { data: myProjects }] = await Promise.all([
    supabase
      .from("notification_project_mutes")
      .select("project_id, projects:project_id(name, project_number)")
      .eq("profile_id", me.id),
    supabase
      .from("projects")
      .select("id, name, project_number")
      .eq("is_template", false)
      .order("project_number", { ascending: false }),
  ])
  const mutedJobs = (muteRows ?? []).map((m) => {
    const p = m.projects as unknown as {
      name: string
      project_number: string
    } | null
    return {
      project_id: m.project_id,
      label: p ? `${p.project_number} — ${p.name}` : "(unknown job)",
    }
  })
  const mutedIds = new Set(mutedJobs.map((m) => m.project_id))
  const muteOptions = (myProjects ?? [])
    .filter((p) => !mutedIds.has(p.id))
    .map((p) => ({
      value: p.id,
      label: `${p.project_number} — ${p.name}`,
    }))

  return (
    <>
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
      <div className="max-w-3xl mx-auto px-4 md:px-6 pb-6">
        <MutedJobsSection muted={mutedJobs} options={muteOptions} />
      </div>
    </>
  )
}
