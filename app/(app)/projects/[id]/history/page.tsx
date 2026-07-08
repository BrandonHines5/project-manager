import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { HistoryClient } from "./history-client"

export const metadata = { title: "History — Hines Homes" }

export default async function ProjectHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireStaff()
  const { id: projectId } = await params
  const supabase = await createSupabaseServerClient()

  const { data: rows, error } = await supabase
    .from("project_history")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)

  return <HistoryClient rows={rows ?? []} />
}
