import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

// Purge core for "Recently deleted" (0088/0089), shared by the History page's
// lazy sweep (staff session) and the daily /api/cron/trash-purge sweep
// (service role). Order matters: list → remove Storage objects → finalize
// (delete rows). Trash rows are the only record of the object paths, so they
// must outlive the removal — any failure here leaves the rows in place and
// the next sweep retries. Paths are re-checked against the live attachment
// tables at purge time so an object re-adopted since the snapshot (an entity
// restored through a different overlapping trash entry, a re-upload to the
// same key) is never removed.

type Client = SupabaseClient<Database>

export async function purgeProjectTrash(
  supabase: Client,
  projectId: string
): Promise<{ purged: number; removedObjects: number }> {
  const { data: expired, error } = await supabase.rpc(
    "list_expired_deleted_items",
    { p_project: projectId }
  )
  if (error) throw new Error(error.message)
  if (!expired || expired.length === 0) return { purged: 0, removedObjects: 0 }

  // Restored entries keep their objects — the live rows reference them again.
  const candidates = [
    ...new Set(
      expired
        .filter((r) => !r.was_restored)
        .flatMap((r) => r.storage_paths ?? [])
    ),
  ]

  let removable: string[] = []
  if (candidates.length > 0) {
    const { data: unreferenced, error: unrefErr } = await supabase.rpc(
      "unreferenced_storage_paths",
      { p_paths: candidates }
    )
    if (unrefErr) throw new Error(unrefErr.message)
    removable = unreferenced ?? []
  }

  for (let i = 0; i < removable.length; i += 100) {
    const { error: removeErr } = await supabase.storage
      .from("project-files")
      .remove(removable.slice(i, i + 100))
    // Abort WITHOUT finalizing: the rows (and their path lists) survive for
    // the next sweep to retry.
    if (removeErr) throw new Error(removeErr.message)
  }

  const { error: finalizeErr } = await supabase.rpc(
    "finalize_purged_deleted_items",
    { p_project: projectId, p_ids: expired.map((r) => r.id) }
  )
  if (finalizeErr) throw new Error(finalizeErr.message)

  return { purged: expired.length, removedObjects: removable.length }
}
