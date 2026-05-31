import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { getSignedUrlsForFiles } from "@/app/actions/files"
import { FilesClient } from "./files-client"
import type { FilesData } from "./files-client"

export const metadata = { title: "Files — Hines Homes" }

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

  const [
    { data: plans },
    { data: logAttachments },
    { data: decisionAttachments },
  ] = await Promise.all([
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
    supabase
      .from("decision_attachments")
      .select("*, decisions!inner(project_id, number, title)")
      .eq("decisions.project_id", projectId),
  ])

  // Build a unified list of all media for the gallery
  type Media = {
    id: string
    storage_path: string
    file_name: string
    file_type: string | null
    caption: string | null
    source: "plan" | "daily-log" | "decision"
    source_label: string
    source_date: string
  }

  const media: Media[] = []

  for (const p of plans ?? []) {
    media.push({
      id: `pf:${p.id}`,
      storage_path: p.storage_path,
      file_name: p.file_name,
      file_type: p.file_type,
      caption: p.title,
      source: "plan",
      source_label: categoryLabel(p.category),
      source_date: p.created_at,
    })
  }
  for (const a of logAttachments ?? []) {
    const dl = (a as unknown as { daily_logs: { log_date: string } }).daily_logs
    media.push({
      id: `dl:${a.id}`,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: a.file_type,
      caption: a.caption,
      source: "daily-log",
      source_label: `Daily log · ${dl.log_date}`,
      source_date: dl.log_date,
    })
  }
  for (const a of decisionAttachments ?? []) {
    const d = (a as unknown as { decisions: { number: number; title: string } })
      .decisions
    media.push({
      id: `dec:${a.id}`,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: a.file_type,
      caption: a.caption,
      source: "decision",
      source_label: `Decision #${d.number} · ${d.title}`,
      source_date: a.created_at,
    })
  }

  const allPaths = [...new Set(media.map((m) => m.storage_path))]
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

function categoryLabel(c: string) {
  return (
    {
      house_plans: "House plans",
      plot_plan: "Plot plan",
      permit: "Permit",
      contract: "Contract",
      other: "Other",
    }[c] ?? c
  )
}
