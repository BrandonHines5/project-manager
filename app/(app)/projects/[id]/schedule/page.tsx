import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { ScheduleClient } from "./schedule-client"
import type { ScheduleData } from "./schedule-client"

export const metadata = { title: "Schedule — Hines Homes" }

export default async function SchedulePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  await requireSession()
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, project_number, name")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: items },
    { data: assignments },
    { data: predecessors },
    { data: checklist },
    { data: delays },
    { data: profiles },
    { data: companies },
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
      .from("profiles")
      .select("id, full_name, email, role, company_id")
      .order("full_name"),
    supabase.from("companies").select("id, name, type, trade_category").order("name"),
  ])

  const strip = <T extends { schedule_items?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { schedule_items: _drop, ...rest } = r
      void _drop
      return rest
    })

  const data: ScheduleData = {
    project_id: projectId,
    items: items ?? [],
    assignments: strip(assignments) as ScheduleData["assignments"],
    predecessors: strip(predecessors) as ScheduleData["predecessors"],
    checklist: strip(checklist) as ScheduleData["checklist"],
    delays: strip(delays) as ScheduleData["delays"],
    profiles: profiles ?? [],
    companies: companies ?? [],
  }

  return <ScheduleClient data={data} />
}
