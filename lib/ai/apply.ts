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
        // Append at the end; position = max(existing) + 1.
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
        const { error } = await supabase
          .from("schedule_items")
          .update({ status: mutation.status })
          .eq("id", mutation.schedule_item_id)
        if (error) throw new Error(error.message)
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
