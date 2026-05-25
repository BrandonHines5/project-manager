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
    { data: costItems },
    { data: costCodes },
    { data: choices },
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
    // Cost line items are RLS-restricted to staff. Clients get an empty
    // array here, which matches what the drawer should show them anyway.
    supabase
      .from("decision_cost_items")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("cost_codes")
      .select("id, code, name, position, is_active")
      .eq("is_active", true)
      .order("position", { ascending: true }),
    supabase
      .from("decision_choices")
      .select("*, decisions!inner(project_id)")
      .eq("decisions.project_id", projectId)
      .order("position", { ascending: true }),
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
    cost_items: strip(costItems) as DecisionsData["cost_items"],
    cost_codes: costCodes ?? [],
    choices: strip(choices) as DecisionsData["choices"],
    signed_urls: signedUrls,
  }

  return <DecisionsClient data={data} />
}
