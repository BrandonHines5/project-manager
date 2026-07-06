import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { getSignedUrlsForDecisions } from "@/app/actions/decisions"
import { DecisionsClient } from "./decisions-client"
import type { DecisionsData } from "./decisions-client"

export const metadata = { title: "Decisions — Hines Homes" }

export default async function DecisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ open?: string }>
}) {
  const { id: projectId } = await params
  const { open } = await searchParams
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
    { data: workItems },
    { data: projects },
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
    // Work items in this project — follow-up to-dos can anchor their due date
    // to one of these (start/end ± offset), same as standalone to-dos.
    supabase
      .from("schedule_items")
      .select("id, title, start_date, end_date")
      .eq("project_id", projectId)
      .eq("kind", "work")
      .order("start_date", { ascending: true, nullsFirst: false }),
    // Projects the caller can see — destinations for "copy to another job".
    // RLS scopes this to the staff's accessible projects.
    supabase
      .from("projects")
      .select("id, name, project_number")
      .order("project_number", { ascending: true }),
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

  const cleanedDecisions = decisions ?? []
  const data: DecisionsData = {
    project_id: projectId,
    role: profile.role,
    me_id: profile.id,
    me_name: profile.full_name || profile.email || "User",
    // Deep link (?open=<decision_id>) — validated against the RLS-filtered
    // list, so a client can only target decisions they can already see.
    open_decision_id:
      open && cleanedDecisions.some((d) => d.id === open) ? open : null,
    decisions: cleanedDecisions,
    followups: strip(followups) as DecisionsData["followups"],
    attachments: cleanedAttachments,
    comments: strip(comments) as DecisionsData["comments"],
    profiles: profiles ?? [],
    companies: companies ?? [],
    cost_items: strip(costItems) as DecisionsData["cost_items"],
    cost_codes: costCodes ?? [],
    choices: strip(choices) as DecisionsData["choices"],
    work_items: workItems ?? [],
    projects: projects ?? [],
    signed_urls: signedUrls,
  }

  return <DecisionsClient data={data} />
}
