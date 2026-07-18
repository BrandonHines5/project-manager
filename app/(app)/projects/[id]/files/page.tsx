import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { getSignedUrlsForFiles } from "@/app/actions/files"
import { FilesClient } from "./files-client"
import type { FilesData } from "./files-client"

export const metadata = { title: "Files — BuildFox" }

export default async function FilesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [{ data: plans }, { data: logAttachments }] = await Promise.all([
    // Plans gallery shows only the current revision of each chain — historic
    // versions remain accessible via the per-file "History" affordance.
    supabase
      .from("project_files")
      .select("*")
      .eq("project_id", projectId)
      .eq("is_current", true)
      .order("created_at", { ascending: false }),
    supabase
      .from("daily_log_attachments")
      .select("*, daily_logs!inner(project_id, log_date)")
      .eq("daily_logs.project_id", projectId),
  ])

  // Gallery media = job-log photos only. Plans live in their own section
  // above and decision attachments stay on the decisions page. `source_id`
  // carries the row's real id (decoupled from the synthetic Media.id used as
  // a React key) so the gallery's tag editor can dispatch back to
  // setMediaTags without parsing the prefix again.
  type Media = {
    id: string
    source_id: string
    storage_path: string
    file_name: string
    file_type: string | null
    caption: string | null
    source: "plan" | "daily-log" | "decision"
    source_label: string
    source_date: string
    tags: string[]
  }

  const media: Media[] = []

  for (const a of logAttachments ?? []) {
    const dl = (a as unknown as { daily_logs: { log_date: string } }).daily_logs
    media.push({
      id: `dl:${a.id}`,
      source_id: a.id,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: a.file_type,
      caption: a.caption,
      source: "daily-log",
      source_label: `Job log · ${dl.log_date}`,
      source_date: dl.log_date,
      tags: a.tags ?? [],
    })
  }
  // Include every plan (archived ones too) so the plan cards, Archived
  // folder, and DocViewer can still preview/download — plans no longer feed
  // the gallery, so their paths come from the plans list alone.
  const allPaths = [
    ...new Set([
      ...(plans ?? []).map((p) => p.storage_path),
      ...media.map((m) => m.storage_path),
    ]),
  ]
  const signedUrls = await getSignedUrlsForFiles(allPaths)

  const data: FilesData = {
    project_id: projectId,
    role: profile.role,
    plans: plans ?? [],
    media,
    signed_urls: signedUrls,
  }

  return <FilesClient data={data} />
}
