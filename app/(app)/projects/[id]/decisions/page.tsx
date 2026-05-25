import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { getSignedUrlsForDecisions } from "@/app/actions/decisions"
import { DecisionsClient } from "./decisions-client"
import type { DecisionsData } from "./decisions-client"

export const metadata = { title: "Decisions — Hines Homes" }

export default async function DecisionsPage({
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
    { data: decisions },
    { data: followups },
    { data: attachments },
    { data: comments },
    { data: profiles },
    { data: companies },
  ] = await Promise.all([
    supabase
      .from("decisions")
      .select("*")
      .eq("project_id", projectId)
      .order("number", { ascending: false }),
    supabase
      .from("decision_followup_templates")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("decision_attachments")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("decision_comments")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", projectId)
      .order("created_at", { ascending: true }),
    supabase.from("profiles").select("id, full_name, email, role"),
    supabase.from("companies").select("id, name, type, trade_category"),
  ])

  const strip = <T extends { decisions?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { decisions: _drop, ...rest } = r
      void _drop
      return rest
    })

  const cleanedAttachments = strip(attachments) as DecisionsData["attachments"]
  const signedUrls = await getSignedUrlsForDecisions(
    cleanedAttachments.map((a) => a.storage_path)
  )

  const data: DecisionsData = {
    project_id: projectId,
    role: profile.role,
    me_id: profile.id,
    me_name: profile.full_name || profile.email || "User",
    decisions: decisions ?? [],
    followups: strip(followups) as DecisionsData["followups"],
    attachments: cleanedAttachments,
    comments: strip(comments) as DecisionsData["comments"],
    profiles: profiles ?? [],
    companies: companies ?? [],
    signed_urls: signedUrls,
  }

  return <DecisionsClient data={data} />
}
