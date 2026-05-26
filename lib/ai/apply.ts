import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, TablesUpdate } from "@/lib/db/types"
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
      case "update_schedule_item": {
        // Patch-only update — only the keys present in `patch` are sent.
        // duration_days isn't in the patch but the schedule UI shows it
        // derived from start/end; if both are present in the patch, also
        // recompute duration_days so the gantt stays consistent. Keeps
        // behavior aligned with saveScheduleItem in app/actions/schedule.ts.
        const patch: TablesUpdate<"schedule_items"> = { ...mutation.patch }
        if (
          typeof patch.start_date === "string" &&
          typeof patch.end_date === "string"
        ) {
          const start = new Date(patch.start_date)
          const end = new Date(patch.end_date)
          patch.duration_days =
            Math.round((end.getTime() - start.getTime()) / 86400000) + 1
        }
        const { data, error } = await supabase
          .from("schedule_items")
          .update(patch)
          .eq("id", mutation.schedule_item_id)
          .select("id")
          .maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) {
          throw new Error("schedule item not found or not permitted")
        }
        return { mutation, ok: true }
      }
      case "create_todo": {
        const { error } = await supabase.from("schedule_items").insert({
          project_id: mutation.project_id,
          kind: "todo",
          title: mutation.title,
          description: mutation.description,
          due_date: mutation.due_date,
          parent_id: mutation.parent_id,
        })
        if (error) throw new Error(error.message)
        return { mutation, ok: true }
      }
      case "create_work_item": {
        // Mirror the date math in saveScheduleItem so duration_days lands
        // in sync — the gantt reads it for the bar width.
        const start = new Date(mutation.start_date)
        const end = new Date(mutation.end_date)
        const durationDays =
          Math.round((end.getTime() - start.getTime()) / 86400000) + 1
        const { error } = await supabase.from("schedule_items").insert({
          project_id: mutation.project_id,
          kind: "work",
          title: mutation.title,
          description: mutation.description,
          start_date: mutation.start_date,
          end_date: mutation.end_date,
          duration_days: durationDays,
        })
        if (error) throw new Error(error.message)
        return { mutation, ok: true }
      }
      case "create_decision": {
        // Race-safe per-project numbering via the existing RPC (same path
        // saveDecision uses). Retry once on the unique violation in case
        // the agent's plan straddles a concurrent save.
        for (let attempt = 0; attempt < 5; attempt++) {
          const { data: nextNum, error: rpcErr } = await supabase.rpc(
            "next_decision_number",
            { p_project: mutation.project_id }
          )
          if (rpcErr) throw new Error(rpcErr.message)
          const number = Number(nextNum)
          const { error } = await supabase.from("decisions").insert({
            project_id: mutation.project_id,
            kind: mutation.decision_kind,
            title: mutation.title,
            description: mutation.description,
            number,
            status: "draft",
          })
          if (!error) return { mutation, ok: true }
          if ((error as { code?: string }).code !== "23505") {
            throw new Error(error.message)
          }
          await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
        }
        throw new Error(
          "Could not allocate a decision number after 5 attempts."
        )
      }
      case "update_decision_status": {
        const update: TablesUpdate<"decisions"> = { status: mutation.status }
        // Mirror saveDecision: set approved_at when crossing into approved.
        if (mutation.status === "approved") {
          update.approved_at = new Date().toISOString()
        }
        const { data, error } = await supabase
          .from("decisions")
          .update(update)
          .eq("id", mutation.decision_id)
          .select("id")
          .maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) {
          throw new Error("decision not found or not permitted")
        }
        return { mutation, ok: true }
      }
      case "add_decision_followup": {
        // Append at the end. Same benign race as the checklist append —
        // position only affects sort order and there's no unique constraint.
        const { data: existing, error: pErr } = await supabase
          .from("decision_followup_templates")
          .select("position")
          .eq("decision_id", mutation.decision_id)
          .order("position", { ascending: false })
          .limit(1)
        if (pErr) throw new Error(pErr.message)
        const nextPos = (existing?.[0]?.position ?? -1) + 1
        const { error } = await supabase
          .from("decision_followup_templates")
          .insert({
            decision_id: mutation.decision_id,
            title: mutation.title,
            due_offset_days: mutation.due_offset_days,
            assignee_profile_id: mutation.assignee_profile_id,
            assignee_company_id: mutation.assignee_company_id,
            position: nextPos,
          })
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
