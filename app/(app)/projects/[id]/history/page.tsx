import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { purgeExpiredTrash } from "@/app/actions/trash"
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

  // Lazy trash maintenance: drop entries past the 30-day retention (and
  // their Storage objects) whenever staff open the page that renders them.
  // Best-effort — a purge hiccup must never take down the History tab.
  try {
    await purgeExpiredTrash(projectId)
  } catch {
    // ignore
  }

  const [{ data: rows, error }, { data: trash, error: trashErr }] =
    await Promise.all([
      supabase
        .from("project_history")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("deleted_items")
        .select("id, entity_type, entity_label, deleted_by_name, deleted_at")
        .eq("project_id", projectId)
        .is("restored_at", null)
        .order("deleted_at", { ascending: false })
        .limit(200),
    ])
  if (error) throw new Error(error.message)
  if (trashErr) throw new Error(trashErr.message)

  return (
    <HistoryClient rows={rows ?? []} projectId={projectId} trash={trash ?? []} />
  )
}
