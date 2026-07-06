import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, TablesUpdate } from "@/lib/db/types"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import type { ProposedMutation, AppliedMutation } from "./types"

/**
 * Execute a single approved mutation. RLS is the source of truth for who can
 * write what — every call here runs under the caller's session, so an
 * agent-proposed mutation the user couldn't perform manually will fail at
 * the DB layer rather than silently slipping through.
 */
async function applyOne(
  supabase: SupabaseClient<Database>,
  mutation: ProposedMutation,
  actorId: string
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
        // Atomic position allocation via the RPC introduced in migration
        // 0025: it locks the parent row, reads max(position), inserts at
        // max+1, all in one transaction. Eliminates the race where two
        // concurrent plan-applies on the same checklist produced
        // co-located rows with unstable sort order.
        const { error } = await supabase.rpc("append_checklist_item", {
          p_schedule_item_id: mutation.schedule_item_id,
          p_label: mutation.label,
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
        // derived from start/end. If EITHER date changed (not both), fall
        // back to the stored value for the other side so duration stays
        // consistent — otherwise a one-sided patch would leave a stale
        // duration in the DB. Mirrors how saveScheduleItem keeps these in
        // sync via its (startD, endD) pair.
        const patch: TablesUpdate<"schedule_items"> = { ...mutation.patch }
        const hasStartPatch = "start_date" in patch
        const hasEndPatch = "end_date" in patch
        if (hasStartPatch || hasEndPatch) {
          let startStr = patch.start_date as string | null | undefined
          let endStr = patch.end_date as string | null | undefined
          if (startStr === undefined || endStr === undefined) {
            const { data: existing, error: exErr } = await supabase
              .from("schedule_items")
              .select("start_date, end_date")
              .eq("id", mutation.schedule_item_id)
              .maybeSingle()
            if (exErr) throw new Error(exErr.message)
            if (existing) {
              if (startStr === undefined) startStr = existing.start_date
              if (endStr === undefined) endStr = existing.end_date
            }
          }
          if (typeof startStr === "string" && typeof endStr === "string") {
            const start = new Date(startStr)
            const end = new Date(endStr)
            patch.duration_days =
              Math.round((end.getTime() - start.getTime()) / 86400000) + 1
          } else if (startStr === null || endStr === null) {
            // Date was explicitly cleared — duration no longer meaningful.
            patch.duration_days = null
          }
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
          created_by: actorId,
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
          created_by: actorId,
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
            created_by: actorId,
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
      case "append_daily_log": {
        // Append to the most recent log for this project + date, or create
        // a fresh internal one. The proposal's appends_to_existing flag is
        // display-only — we re-check here because another log may have been
        // saved between propose and apply.
        const { data: existing, error: exErr } = await supabase
          .from("daily_logs")
          .select("id, notes")
          .eq("project_id", mutation.project_id)
          .eq("log_date", mutation.log_date)
          .order("created_at", { ascending: false })
          .limit(1)
        if (exErr) throw new Error(exErr.message)
        const target = existing?.[0]
        if (target) {
          const notes = target.notes
            ? `${target.notes.trimEnd()}\n\n${mutation.note}`
            : mutation.note
          const { data, error } = await supabase
            .from("daily_logs")
            .update({ notes })
            .eq("id", target.id)
            .select("id")
            .maybeSingle()
          if (error) throw new Error(error.message)
          if (!data) {
            throw new Error("daily log not found or not permitted")
          }
        } else {
          const { error } = await supabase.from("daily_logs").insert({
            project_id: mutation.project_id,
            log_date: mutation.log_date,
            visibility: "internal",
            notes: mutation.note,
            created_by: actorId,
          })
          if (error) throw new Error(error.message)
        }
        return { mutation, ok: true }
      }
      case "send_sms": {
        // Mirror sendQuoTextToSub's assignment check (app/actions/schedule.ts):
        // texting is reserved for subs that are actually assigned to work.
        // The mutation doesn't carry a schedule_item_id to scope the lookup
        // to one item, so require the company to have at least one schedule
        // assignment visible to the caller's session — a tampered plan can't
        // text an arbitrary companies row that was never put on a schedule.
        const { data: assignment, error: aErr } = await supabase
          .from("schedule_assignments")
          .select("id")
          .eq("company_id", mutation.company_id)
          .limit(1)
          .maybeSingle()
        if (aErr) throw new Error(aErr.message)
        if (!assignment) {
          throw new Error(
            "company has no schedule assignment — texts can only go to subs assigned to a schedule item"
          )
        }
        // Re-resolve the recipient from the companies row — never trust the
        // phone that round-tripped through the client. RLS gates the read.
        const { data: company, error } = await supabase
          .from("companies")
          .select("id, name, phone")
          .eq("id", mutation.company_id)
          .maybeSingle()
        if (error) throw new Error(error.message)
        if (!company) {
          throw new Error("company not found or not permitted")
        }
        if (!company.phone) {
          throw new Error(`${company.name} has no phone number on file`)
        }
        const e164 = normalizeE164(company.phone)
        if (!e164) {
          throw new Error(
            `${company.name} has an invalid phone number on file: ${company.phone}`
          )
        }
        const result = await sendQuoSms({
          to: e164,
          content: mutation.message,
          log: {
            company_id: company.id,
            sent_by: actorId,
            kind: "ai_sms",
            counterparty_name: company.name,
          },
        })
        if (!result.sent) {
          throw new Error(result.reason ?? "SMS send failed")
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
  mutations: ProposedMutation[],
  actorId: string
): Promise<AppliedMutation[]> {
  // Sequential, not parallel — keeps the failure ordering deterministic for
  // the user's "applied / failed" report, and a typical plan is small enough
  // that the extra round-trips don't matter.
  const out: AppliedMutation[] = []
  for (const m of mutations) {
    out.push(await applyOne(supabase, m, actorId))
  }
  return out
}
