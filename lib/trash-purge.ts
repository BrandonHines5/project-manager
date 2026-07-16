import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

// Purge core for "Recently deleted" (0088/0089/0090), shared by the History
// page's lazy sweep (staff session) and the daily /api/cron/trash-purge sweep
// (service role). Order matters: claim a batch → verify paths are
// unreferenced → remove Storage objects → finalize (delete rows).
//
// - Claiming (purge_claimed_at) serializes purge against restore: a claimed
//   entry can't be restored, so nothing can re-attach a path between the
//   reference check and the .remove(). Stale claims (a crashed sweep)
//   re-sweep after an hour; a failed removal unclaims immediately.
// - Trash rows are the only record of the object paths, so they must outlive
//   the removal — any failure leaves the rows in place and the next sweep
//   retries.
// - Batching (200 rows/round) keeps every RPC response far under PostgREST's
//   1,000-row cap; rounds loop until a claim comes back empty, so even a
//   huge backlog drains in one sweep.

type Client = SupabaseClient<Database>

const BATCH = 200
// Safety valve — 50 × 200 = 10k entries per project per sweep, far beyond
// anything real; the next sweep picks up whatever a capped run left.
const MAX_ROUNDS = 50

export async function purgeProjectTrash(
  supabase: Client,
  projectId: string
): Promise<{ purged: number; removedObjects: number }> {
  let purged = 0
  let removedObjects = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data: batch, error } = await supabase.rpc(
      "claim_expired_deleted_items",
      { p_project: projectId, p_limit: BATCH }
    )
    if (error) throw new Error(error.message)
    if (!batch || batch.length === 0) break

    // Restored entries keep their objects — the live rows reference them
    // again. (An entry can't flip to restored after this point: it's claimed.)
    const candidates = [
      ...new Set(
        batch.filter((r) => !r.was_restored).flatMap((r) => r.storage_paths ?? [])
      ),
    ]

    try {
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
        if (removeErr) throw new Error(removeErr.message)
      }
      removedObjects += removable.length
    } catch (e) {
      // Release the batch so the next sweep retries right away (instead of
      // waiting out the stale-claim hour), then surface the failure.
      await supabase.rpc("unclaim_purged_deleted_items", {
        p_project: projectId,
        p_ids: batch.map((r) => r.id),
      })
      throw e instanceof Error ? e : new Error(String(e))
    }

    const { error: finalizeErr } = await supabase.rpc(
      "finalize_purged_deleted_items",
      { p_project: projectId, p_ids: batch.map((r) => r.id) }
    )
    if (finalizeErr) throw new Error(finalizeErr.message)
    purged += batch.length

    if (batch.length < BATCH) break
  }

  return { purged, removedObjects }
}
