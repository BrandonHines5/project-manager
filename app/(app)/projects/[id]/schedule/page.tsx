import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { ScheduleClient } from "./schedule-client"
import type { ScheduleData } from "./schedule-client"

export const metadata = { title: "Schedule — Hines Homes" }

export default async function SchedulePage({
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
    .select("id, project_number, name, address")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: items },
    { data: assignments },
    { data: predecessors },
    { data: checklist },
    { data: delays },
    { data: attachments },
    { data: profiles },
    { data: companies },
    { data: roles },
    { data: roleMembers },
    { data: comments },
  ] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("*")
      .eq("project_id", projectId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("schedule_assignments")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", projectId),
    supabase
      .from("schedule_predecessors")
      .select("*, schedule_items!schedule_predecessors_item_id_fkey!inner(project_id)")
      .eq("schedule_items.project_id", projectId),
    supabase
      .from("todo_checklist_items")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("schedule_delays")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", projectId)
      .order("logged_at", { ascending: false }),
    supabase
      .from("schedule_item_attachments")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, full_name, email, role, company_id")
      .order("full_name"),
    supabase
      .from("companies")
      .select("id, name, type, trade_category, phone")
      .order("name"),
    supabase
      .from("roles")
      .select("id, name, kind")
      .order("position", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("project_role_members")
      .select("role_id, profile_id, company_id")
      .eq("project_id", projectId),
    supabase
      .from("schedule_item_comments")
      .select("*, schedule_items!inner(project_id)")
      .eq("schedule_items.project_id", projectId)
      .order("created_at", { ascending: true }),
  ])

  const strip = <T extends { schedule_items?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { schedule_items: _drop, ...rest } = r
      void _drop
      return rest
    })

  const cleanedAttachments = strip(attachments) as ScheduleData["attachments"]
  const attachmentPaths = cleanedAttachments.map((a) => a.storage_path)
  const signedUrls: Record<string, string> = {}
  if (attachmentPaths.length > 0) {
    const { data: signed, error: signedErr } = await supabase.storage
      .from("project-files")
      .createSignedUrls(attachmentPaths, 3600)
    if (signedErr) throw new Error(signedErr.message)
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) signedUrls[s.path] = s.signedUrl
    }
  }

  const cleanedItems = items ?? []
  const data: ScheduleData = {
    project_id: projectId,
    project_address: project.address,
    items: cleanedItems,
    assignments: strip(assignments) as ScheduleData["assignments"],
    predecessors: strip(predecessors) as ScheduleData["predecessors"],
    checklist: strip(checklist) as ScheduleData["checklist"],
    delays: strip(delays) as ScheduleData["delays"],
    attachments: cleanedAttachments,
    signed_urls: signedUrls,
    profiles: profiles ?? [],
    companies: companies ?? [],
    roles: roles ?? [],
    roleMembers: roleMembers ?? [],
    comments: strip(comments) as ScheduleData["comments"],
    role: profile.role,
    me_name: profile.full_name ?? profile.email ?? "Me",
    // Deep link (?open=<item_id>) from the Communications feed / bell —
    // validated against the RLS-filtered items so a stale or foreign id
    // silently no-ops.
    open_item_id:
      open && cleanedItems.some((i) => i.id === open) ? open : null,
  }

  return <ScheduleClient data={data} />
}
