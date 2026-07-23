import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, TablesUpdate } from "@/lib/db/types"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { sendEmail, appUrl } from "@/lib/email"
import { formatDate } from "@/lib/utils"
import { rollRecurringTodo } from "@/lib/schedule/roll-recurrence"
import type { ProposedMutation, AppliedMutation } from "./types"

// Best-effort in-app notification for a staff (profile) assignee, mirroring
// the in-app portion of notifyScheduleAssignees in app/actions/schedule.ts.
// Company assignees are external subs (no in-app notifications); the AI path
// records the assignment — they see it in their portal — but does not
// email/SMS them in v1. Never throws: a failed notify must not fail the
// assignment that already committed.
async function notifyProfileAssignee(
  supabase: SupabaseClient<Database>,
  profileId: string,
  projectId: string,
  itemTitle: string
): Promise<void> {
  try {
    // supabase-js resolves with { error } instead of throwing, so check it
    // explicitly — the try/catch only covers transport-level rejections.
    const { error } = await supabase.from("notifications").insert({
      recipient_id: profileId,
      type: "schedule_assignment",
      title: `Assigned: ${itemTitle}`,
      body: "You were assigned to a schedule item",
      link_url: `/projects/${projectId}/schedule`,
      // Lets the notifications trigger honor per-job mutes (0121).
      project_id: projectId,
    })
    if (error) {
      console.warn(
        "[ai apply] assignment notification failed (non-fatal):",
        error.message
      )
    }
  } catch (e) {
    console.warn(
      "[ai apply] assignment notification failed (non-fatal):",
      e instanceof Error ? e.message : String(e)
    )
  }
}

// Insert an assignment idempotently: skip when the same (item, profile,
// company) pair already exists so re-applying a plan doesn't error on the
// uq_schedule_assignments_target unique index. Returns the profile_id that
// was NEWLY assigned (for notification), or null.
async function upsertAssignment(
  supabase: SupabaseClient<Database>,
  scheduleItemId: string,
  profileId: string | null,
  companyId: string | null
): Promise<{ newlyAssignedProfileId: string | null }> {
  let q = supabase
    .from("schedule_assignments")
    .select("id")
    .eq("schedule_item_id", scheduleItemId)
  q = profileId ? q.eq("profile_id", profileId) : q.is("profile_id", null)
  q = companyId ? q.eq("company_id", companyId) : q.is("company_id", null)
  const { data: existing, error: exErr } = await q.is("role_id", null).limit(1)
  if (exErr) throw new Error(exErr.message)
  if (existing && existing.length > 0) {
    return { newlyAssignedProfileId: null }
  }
  const { error } = await supabase.from("schedule_assignments").insert({
    schedule_item_id: scheduleItemId,
    profile_id: profileId,
    company_id: companyId,
  })
  if (error) throw new Error(error.message)
  return { newlyAssignedProfileId: profileId }
}

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
        // Baseline gate, mirroring setItemStatus: a work item can't cross
        // into `complete` until the project's schedule baseline is locked.
        if (mutation.status === "complete") {
          const { data: item, error: iErr } = await supabase
            .from("schedule_items")
            .select("kind, status, project_id")
            .eq("id", mutation.schedule_item_id)
            .maybeSingle()
          if (iErr) throw new Error(iErr.message)
          if (item && item.kind === "work" && item.status !== "complete") {
            const { data: proj, error: pErr } = await supabase
              .from("projects")
              .select("baseline_set_at")
              .eq("id", item.project_id)
              .maybeSingle()
            if (pErr) throw new Error(pErr.message)
            if (!proj?.baseline_set_at) {
              throw new Error(
                "the schedule baseline isn't locked yet — set it on the schedule page before completing work items"
              )
            }
          }
        }
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
        // Recurring to-do completed via the agent: spawn its next occurrence,
        // same as every other completion path.
        if (mutation.status === "complete") {
          await rollRecurringTodo(supabase, mutation.schedule_item_id)
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
        let prior: {
          kind: "work" | "todo"
          start_date: string | null
          end_date: string | null
          project_id: string
        } | null = null
        if (hasStartPatch || hasEndPatch) {
          // Always load the stored row when dates are involved: it completes
          // one-sided patches for the duration math below AND tells us
          // whether this move needs a schedule_delays entry (baselined
          // project + work item).
          const { data: existing, error: exErr } = await supabase
            .from("schedule_items")
            .select("kind, start_date, end_date, project_id")
            .eq("id", mutation.schedule_item_id)
            .maybeSingle()
          if (exErr) throw new Error(exErr.message)
          prior = existing
          let startStr = patch.start_date as string | null | undefined
          let endStr = patch.end_date as string | null | undefined
          if (existing) {
            if (startStr === undefined) startStr = existing.start_date
            if (endStr === undefined) endStr = existing.end_date
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
        // Post-baseline date moves on work items always leave a
        // schedule_delays trail. Human moves collect a reason in the UI
        // popup; agent-applied moves log under "other" with a stock note so
        // the Delay Report stays complete. Best-effort — the move itself
        // already landed.
        if (prior && prior.kind === "work") {
          const newStart = hasStartPatch
            ? ((patch.start_date as string | null) ?? null)
            : prior.start_date
          const newEnd = hasEndPatch
            ? ((patch.end_date as string | null) ?? null)
            : prior.end_date
          const moved =
            prior.start_date !== newStart || prior.end_date !== newEnd
          if (moved) {
            const { data: proj } = await supabase
              .from("projects")
              .select("baseline_set_at")
              .eq("id", prior.project_id)
              .maybeSingle()
            if (proj?.baseline_set_at) {
              const diff = (a: string, b: string) =>
                Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
              const delayDays =
                prior.end_date && newEnd
                  ? diff(prior.end_date, newEnd)
                  : prior.start_date && newStart
                    ? diff(prior.start_date, newStart)
                    : 0
              const { error: dErr } = await supabase
                .from("schedule_delays")
                .insert({
                  schedule_item_id: mutation.schedule_item_id,
                  delay_days: delayDays,
                  reason_category: "other",
                  notes: "Dates changed via AI plan apply",
                  logged_by: actorId,
                })
              if (dErr) {
                console.warn(
                  "[ai apply] move-reason delay log failed:",
                  dErr.message
                )
              }
            }
          }
        }
        return { mutation, ok: true }
      }
      case "create_todo": {
        const { data: created, error } = await supabase
          .from("schedule_items")
          .insert({
            project_id: mutation.project_id,
            kind: "todo",
            title: mutation.title,
            description: mutation.description,
            due_date: mutation.due_date,
            parent_id: mutation.parent_id,
            created_by: actorId,
          })
          .select("id")
          .single()
        if (error) throw new Error(error.message)
        // Optional assignee: add the assignment and notify a staff assignee.
        // Best-effort — the to-do already exists, so a failed assignment
        // shouldn't sink the whole mutation.
        if (mutation.assignee_profile_id || mutation.assignee_company_id) {
          try {
            const { newlyAssignedProfileId } = await upsertAssignment(
              supabase,
              created.id,
              mutation.assignee_profile_id,
              mutation.assignee_company_id
            )
            if (newlyAssignedProfileId) {
              await notifyProfileAssignee(
                supabase,
                newlyAssignedProfileId,
                mutation.project_id,
                mutation.title
              )
            }
          } catch (e) {
            console.warn(
              "[ai apply] create_todo assignment failed (non-fatal):",
              e instanceof Error ? e.message : String(e)
            )
          }
        }
        return { mutation, ok: true }
      }
      case "assign_schedule_item": {
        // Verify the target exists under the caller's session (RLS) and pull
        // the project id for the notification link.
        const { data: item, error: iErr } = await supabase
          .from("schedule_items")
          .select("id, title, project_id")
          .eq("id", mutation.schedule_item_id)
          .maybeSingle()
        if (iErr) throw new Error(iErr.message)
        if (!item) {
          throw new Error("schedule item not found or not permitted")
        }
        const { newlyAssignedProfileId } = await upsertAssignment(
          supabase,
          mutation.schedule_item_id,
          mutation.assignee_profile_id,
          mutation.assignee_company_id
        )
        if (newlyAssignedProfileId) {
          await notifyProfileAssignee(
            supabase,
            newlyAssignedProfileId,
            item.project_id,
            item.title
          )
        }
        return { mutation, ok: true }
      }
      case "create_work_item": {
        // Mirror the date math in saveScheduleItem so duration_days lands
        // in sync — the gantt reads it for the bar width.
        const start = new Date(mutation.start_date)
        const end = new Date(mutation.end_date)
        const durationDays =
          Math.round((end.getTime() - start.getTime()) / 86400000) + 1
        // Work items born after the baseline lock get their initial dates as
        // baseline (mirrors saveScheduleItem's insert path).
        const { data: proj, error: projErr } = await supabase
          .from("projects")
          .select("baseline_set_at")
          .eq("id", mutation.project_id)
          .maybeSingle()
        if (projErr) throw new Error(projErr.message)
        const { error } = await supabase.from("schedule_items").insert({
          project_id: mutation.project_id,
          kind: "work",
          title: mutation.title,
          description: mutation.description,
          start_date: mutation.start_date,
          end_date: mutation.end_date,
          duration_days: durationDays,
          created_by: actorId,
          ...(proj?.baseline_set_at
            ? {
                baseline_start_date: mutation.start_date,
                baseline_end_date: mutation.end_date,
              }
            : {}),
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
        let logId: string
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
          logId = data.id
        } else {
          const { data, error } = await supabase
            .from("daily_logs")
            .insert({
              project_id: mutation.project_id,
              log_date: mutation.log_date,
              visibility: "internal",
              notes: mutation.note,
              created_by: actorId,
            })
            .select("id")
            .single()
          if (error) throw new Error(error.message)
          logId = data.id
        }
        const photos = mutation.attachments ?? []
        if (photos.length > 0) {
          // The prefix check is the security boundary: attachments arrive
          // from the client (the walkthrough uploaded them with the user's
          // own JWT), and without it a tampered plan could link any object
          // in the bucket — say a COI under companies/insurance/ — into a
          // log that might later be flipped to client visibility.
          const prefix = `projects/${mutation.project_id}/daily-logs/`
          const invalid = photos.find((p) => !p.storage_path.startsWith(prefix))
          if (invalid) {
            return {
              mutation,
              ok: false,
              error: `Note saved, but photos were not attached: ${invalid.storage_path} is outside this project's daily-logs folder`,
            }
          }
          // Position new photos after whatever the log already has (a
          // second same-day walkthrough appends, not overwrites).
          const { count, error: cErr } = await supabase
            .from("daily_log_attachments")
            .select("id", { count: "exact", head: true })
            .eq("daily_log_id", logId)
          if (cErr) {
            return {
              mutation,
              ok: false,
              error: `Note saved, but attaching ${photos.length} photo(s) failed: ${cErr.message}`,
            }
          }
          const base = count ?? 0
          const { error: aErr } = await supabase
            .from("daily_log_attachments")
            .insert(
              photos.map((p, i) => ({
                daily_log_id: logId,
                storage_path: p.storage_path,
                file_name: p.file_name,
                file_type: p.file_type,
                file_size: p.file_size,
                caption: p.caption,
                position: base + i,
              }))
            )
          if (aErr) {
            return {
              mutation,
              ok: false,
              error: `Note saved, but attaching ${photos.length} photo(s) failed: ${aErr.message}`,
            }
          }
        }
        // Record subs on site structurally (in addition to the note prose) so
        // the who-was-on-site report is complete for AI-created logs. Upsert
        // with the (daily_log_id, company_id) PK so re-applying — or a second
        // same-day walkthrough — dedupes instead of erroring. (The manual
        // drawer's "newly on site" courtesy SMS is intentionally not fired
        // here; the AI path just records presence.)
        const subs = mutation.subs_on_site ?? []
        if (subs.length > 0) {
          const { error: sErr } = await supabase
            .from("daily_log_subs_on_site")
            .upsert(
              subs.map((s) => ({
                daily_log_id: logId,
                company_id: s.company_id,
                notes: s.notes,
              })),
              { onConflict: "daily_log_id,company_id", ignoreDuplicates: true }
            )
          if (sErr) {
            return {
              mutation,
              ok: false,
              error: `Note saved, but recording ${subs.length} sub(s) on site failed: ${sErr.message}`,
            }
          }
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
        const { data: assignments, error: aErr } = await supabase
          .from("schedule_assignments")
          .select("id, schedule_items!inner(project_id)")
          .eq("company_id", mutation.company_id)
          .limit(50)
        if (aErr) throw new Error(aErr.message)
        if (!assignments || assignments.length === 0) {
          throw new Error(
            "company has no schedule assignment — texts can only go to subs assigned to a schedule item"
          )
        }
        // Stamp the communications row with a project when the company's
        // assignments unambiguously point at one — an AI-sent text then
        // shows in that job's feed and teaches the inbound-reply matcher's
        // recency heuristic. Multi-job subs stay company-only, as before.
        const assignedProjects = new Set(
          assignments
            .map(
              (a) =>
                (a as unknown as { schedule_items: { project_id: string } })
                  .schedule_items?.project_id
            )
            .filter(Boolean)
        )
        const smsProjectId =
          assignedProjects.size === 1 ? [...assignedProjects][0]! : null
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
            project_id: smsProjectId,
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
      case "send_bid_reminder": {
        // Re-send the invite link to invited-but-unresponded recipients.
        // Never creates recipients and never changes the package status —
        // this is strictly a reminder. Mirrors sendBidPackage's re-send
        // guards (closed package blocks; non-'invited' or token-revoked
        // recipients are skipped).
        const { data: pkg, error: pErr } = await supabase
          .from("bid_packages")
          .select(
            "id, project_id, title, number, due_date, status, projects:project_id(name)"
          )
          .eq("id", mutation.bid_package_id)
          .maybeSingle()
        if (pErr) throw new Error(pErr.message)
        if (!pkg) throw new Error("bid package not found or not permitted")
        if (pkg.status === "closed") {
          throw new Error("this bid package is closed")
        }
        const { data: recipients, error: rErr } = await supabase
          .from("bid_recipients")
          .select(
            "id, company_id, token, status, companies:company_id(name, email, phone, notifications_enabled)"
          )
          .eq("bid_package_id", mutation.bid_package_id)
          .in("company_id", mutation.company_ids)
        if (rErr) throw new Error(rErr.message)

        const projectName =
          (
            pkg as unknown as { projects: { name: string } | null }
          ).projects?.name ?? "our project"
        const dueLine = pkg.due_date
          ? ` Bids are due by ${formatDate(pkg.due_date)}.`
          : ""
        const now = new Date().toISOString()

        const sendJobs: Promise<unknown>[] = []
        for (const r of recipients ?? []) {
          if (r.status !== "invited" || !r.token) continue
          const co = Array.isArray(r.companies) ? r.companies[0] : r.companies
          if (!co || !co.notifications_enabled) continue
          const { error: upErr } = await supabase
            .from("bid_recipients")
            .update({
              last_sent_at: now,
              sent_to_email: co.email,
              sent_to_phone: co.phone,
            })
            .eq("id", r.id)
          if (upErr) throw new Error(upErr.message)
          const link = appUrl(`/bid/${r.token}`)
          const log = {
            project_id: pkg.project_id,
            company_id: r.company_id,
            sent_by: actorId,
            kind: "bid_invite",
            counterparty_name: co.name,
          }
          if (co.email) {
            sendJobs.push(
              sendEmail({
                to: [co.email],
                subject: `Reminder — bid request: ${pkg.title} — ${projectName}`,
                text: `Reminder from Hines Homes: we're still waiting on your bid for "${pkg.title}" on ${projectName}.${dueLine}\n\nView the scope and submit your bid here (no login needed):\n${link}`,
                log,
              }).catch((e) =>
                console.warn("[ai apply] bid reminder email failed:", e)
              )
            )
          }
          const e164 = co.phone ? normalizeE164(co.phone) : null
          if (e164) {
            sendJobs.push(
              sendQuoSms({
                to: e164,
                content: `Hines Homes reminder: still waiting on your bid for "${pkg.title}" on ${projectName}.${dueLine} Submit here: ${link}`,
                log,
              }).catch((e) =>
                console.warn("[ai apply] bid reminder SMS failed:", e)
              )
            )
          }
        }
        await Promise.all(sendJobs)
        // Zero reminders is a soft no-op (everyone may have responded between
        // propose and apply) — not an error.
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
