import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { DailyLogsClient } from "./daily-logs-client"
import { getSignedUrls } from "@/app/actions/daily-logs"
import type { DailyLogsData } from "./daily-logs-client"

export const metadata = { title: "Daily Logs — Hines Homes" }

export default async function DailyLogsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: logs },
    { data: subsOnSite },
    { data: attachments },
    { data: profiles },
    { data: companies },
  ] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("*")
      .eq("project_id", projectId)
      .order("log_date", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("daily_log_subs_on_site")
      .select("*, daily_logs!inner(project_id)")
      .eq("daily_logs.project_id", projectId),
    supabase
      .from("daily_log_attachments")
      .select("*, daily_logs!inner(project_id)")
      .eq("daily_logs.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name"),
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .neq("type", "client")
      .order("name"),
  ])

  const strip = <T extends { daily_logs?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { daily_logs: _drop, ...rest } = r
      void _drop
      return rest
    })

  const cleanedAttachments = strip(attachments) as DailyLogsData["attachments"]
  const signedUrls = await getSignedUrls(
    cleanedAttachments.map((a) => a.storage_path)
  )

  const data: DailyLogsData = {
    project_id: projectId,
    role: profile.role,
    logs: logs ?? [],
    subs_on_site: strip(subsOnSite) as DailyLogsData["subs_on_site"],
    attachments: cleanedAttachments,
    profiles: profiles ?? [],
    companies: companies ?? [],
    signed_urls: signedUrls,
  }

  return <DailyLogsClient data={data} />
}
