import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import type { ProposedMutation, AppliedMutation } from "./types"

/**
 * Execute a single approved mutation. RLS is the source of truth for who can
 * write what — every call here runs under the caller's session, so an
 * agent-proposed mutation the user couldn't perform manually will fail at
 * the DB layer rather than silently slipping through.
 */
async function applyOne(
  supabase: SupabaseClient<Database>,
  mutation: ProposedMutation
): Promise<AppliedMutation> {
  try {
    switch (mutation.kind) {
      case "add_checklist_item": {
        // Re-validate the target's kind on the server even though the
        // propose tool already checked. A tampered apply payload could
        // request a checklist insert against a work item; there's no DB
        // constraint preventing that, so we have to gate it here.
        const { data: target, error: tErr } = await supabase
          .from("schedule_items")
          .select("id, kind")
          .eq("id", mutation.schedule_item_id)
          .maybeSingle()
        if (tErr) throw new Error(tErr.message)
        if (!target) {
          throw new Error("schedule item not found or not permitted")
        }
        if (target.kind !== "todo") {
          throw new Error(
            "checklist items can only be added to to-do items"
          )
        }
        // Append at the end; position = max(existing) + 1.
        //
        // Known race: two concurrent appends on the same checklist can
        // compute the same `nextPos` and end up co-located, producing an
        // unstable sort between the two new rows. There's no unique
        // constraint on (schedule_item_id, position), so no insert fails
        // and no data is corrupted — the worst case is a cosmetic ordering
        // glitch on simultaneous applies. If this becomes a real problem,
        // move to a SECURITY DEFINER RPC that allocates `position`
        // atomically. Not worth the round-trip for v1.
        const { data: existing, error: pErr } = await supabase
          .from("todo_checklist_items")
          .select("position")
          .eq("schedule_item_id", mutation.schedule_item_id)
          .order("position", { ascending: false })
          .limit(1)
        if (pErr) throw new Error(pErr.message)
        const nextPos = (existing?.[0]?.position ?? -1) + 1
        const { error } = await supabase.from("todo_checklist_items").insert({
          schedule_item_id: mutation.schedule_item_id,
          label: mutation.label,
          is_done: false,
          position: nextPos,
        })
        if (error) throw new Error(error.message)
        return { mutation, ok: true }
      }
      case "update_schedule_item_status": {
        // .select() after .update() so we can tell apart "updated 1 row"
        // from "RLS hid the row" / "id doesn't exist" — without it, both
        // come back as `error: null` and we'd report false-positive success.
        const { data, error } = await supabase
          .from("schedule_items")
          .update({ status: mutation.status })
          .eq("id", mutation.schedule_item_id)
          .select("id")
          .maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) {
          throw new Error("schedule item not found or not permitted")
        }
        return { mutation, ok: true }
      }
    }
  } catch (e) {
    return {
      mutation,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function applyPlan(
  supabase: SupabaseClient<Database>,
  mutations: ProposedMutation[]
): Promise<AppliedMutation[]> {
  // Sequential, not parallel — keeps the failure ordering deterministic for
  // the user's "applied / failed" report, and a typical plan is small enough
  // that the extra round-trips don't matter.
  const out: AppliedMutation[] = []
  for (const m of mutations) {
    out.push(await applyOne(supabase, m))
  }
  return out
}
