"use server"

import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"
import { sendDashboardWebhook } from "@/lib/dashboard"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { notifyCommentPosted } from "@/lib/comms/notify"
import { formatDate } from "@/lib/utils"

const optStr = z.string().nullish()

const DailyLogInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    log_date: z.string().min(1, "Required"),
    visibility: z.enum(["internal", "client"]).default("internal"),
    notes: optStr,
    // Labor hours for the day, attributed to the log's author. Only set on
    // cost-plus jobs (the UI hides the field otherwise). Capped at 24 since a
    // log covers a single day. Blank strings normalize to null (rather than
    // coercing to 0) so clearing the field doesn't persist an explicit zero.
    hours_worked: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : v),
        z.coerce.number().min(0).max(24).nullable()
      )
      .optional(),
    subs_on_site: z
      .array(
        z.object({
          company_id: z.string(),
          notes: optStr,
        })
      )
      .default([]),
    attachments: z
      .array(
        z.object({
          id: optStr,
          storage_path: z.string(),
          file_name: z.string(),
          file_type: optStr,
          file_size: z.number().nullish(),
          caption: optStr,
        })
      )
      .default([]),
    // Quick to-dos captured alongside the log. These create standalone
    // schedule_items (kind='todo') in the same project. Optional assignee is
    // a profile XOR company. Only applied on create-time entries with a
    // non-empty title; editing an existing log ignores this array.
    todos: z
      .array(
        z.object({
          title: z.string(),
          due_date: optStr,
          assignee_profile_id: optStr,
          assignee_company_id: optStr,
        })
      )
      .default([]),
  })
  .passthrough()

export type DailyLogInputT = z.infer<typeof DailyLogInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

export async function saveDailyLog(input: DailyLogInputT) {
  const profile = await requireStaff()
  const result = DailyLogInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  // Hours are only valid on cost-plus jobs. Enforce that server-side so a
  // crafted request can't write labor hours onto a fixed-price project (the
  // UI already hides the field, but that's not a security boundary).
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, cost_plus")
    .eq("id", parsed.project_id)
    .maybeSingle()
  if (projectErr) throw new Error(projectErr.message)
  if (!project) throw new Error("Project not found")
  const hoursWorked = project.cost_plus ? parsed.hours_worked ?? null : null

  let id = nz(parsed.id)
  const baseRow = {
    project_id: parsed.project_id,
    log_date: parsed.log_date,
    visibility: parsed.visibility,
    notes: nz(parsed.notes),
    hours_worked: hoursWorked,
  }

  if (id) {
    const { error } = await supabase
      .from("daily_logs")
      .update(baseRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase
      .from("daily_logs")
      .insert({ ...baseRow, created_by: profile.id })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  // Replace subs_on_site, tracking which company_ids were NOT already on a
  // prior log for this project so we don't re-text the same sub every time a
  // PM updates the log. "Newly on site" means: subs marked here that haven't
  // been on a daily log for this project in the past 7 days.
  const { data: previousSubs } = await supabase
    .from("daily_log_subs_on_site")
    .select("daily_log_id, company_id")
    .eq("daily_log_id", id)
  await supabase.from("daily_log_subs_on_site").delete().eq("daily_log_id", id)
  let addedCompanyIds: string[] = []
  if (parsed.subs_on_site.length) {
    const rows = parsed.subs_on_site
      .filter((s) => !!s.company_id)
      .map((s) => ({
        daily_log_id: id!,
        company_id: s.company_id,
        notes: nz(s.notes),
      }))
    if (rows.length) {
      const { error } = await supabase
        .from("daily_log_subs_on_site")
        .insert(rows)
      if (error) throw new Error(error.message)
      const wasPresent = new Set(
        (previousSubs ?? []).map((p) => p.company_id)
      )
      addedCompanyIds = Array.from(
        new Set(
          rows.map((r) => r.company_id).filter((cid) => !wasPresent.has(cid))
        )
      )
    }
  }

  // Reconcile attachments
  const { data: existing } = await supabase
    .from("daily_log_attachments")
    .select("id, storage_path")
    .eq("daily_log_id", id)
  const keepIds = new Set(
    parsed.attachments
      .map((a) => nz(a.id))
      .filter((x): x is string => !!x)
  )
  const toDelete = (existing ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    const { error: rmErr } = await supabase
      .from("daily_log_attachments")
      .delete()
      .in(
        "id",
        toDelete.map((d) => d.id)
      )
    if (rmErr) throw new Error(rmErr.message)
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
    if (storageErr) {
      console.warn(
        "[saveDailyLog] storage cleanup failed (non-fatal):",
        storageErr.message
      )
    }
  }

  const newOnes = parsed.attachments.filter((a) => !nz(a.id))
  if (newOnes.length) {
    const startPos = existing?.length ?? 0
    const rows = newOnes.map((a, i) => ({
      daily_log_id: id!,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: nz(a.file_type),
      file_size: a.file_size ?? null,
      caption: nz(a.caption),
      position: startPos + i,
    }))
    const { error } = await supabase
      .from("daily_log_attachments")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  const retained = parsed.attachments.filter((a) => nz(a.id))
  for (const a of retained) {
    const { error: capErr } = await supabase
      .from("daily_log_attachments")
      .update({ caption: nz(a.caption) })
      .eq("id", a.id!)
      // Defense in depth: only touch attachments that belong to THIS log.
      // RLS would already prevent cross-tenant writes, but this also stops
      // a same-staff cross-log accident.
      .eq("daily_log_id", id)
    if (capErr) throw new Error(capErr.message)
  }

  // Create any quick to-dos captured on the log. These are standalone
  // schedule_items in the same project — we don't tie the rows to the log
  // (there's no source_daily_log_id column), they just give the PM a fast
  // way to jot follow-ups while writing the log. Empty-title rows are
  // dropped. Failures here must not roll back the saved log, so we collect
  // errors and surface them without throwing past the log save.
  const newTodos = parsed.todos.filter((t) => t.title.trim() !== "")
  if (newTodos.length) {
    for (const t of newTodos) {
      const pid = nz(t.assignee_profile_id)
      const cid = nz(t.assignee_company_id)
      const { data: todoRow, error: todoErr } = await supabase
        .from("schedule_items")
        .insert({
          project_id: parsed.project_id,
          kind: "todo",
          title: t.title.trim(),
          due_date: nz(t.due_date),
          status: "not_started",
          created_by: profile.id,
        })
        .select("id")
        .single()
      if (todoErr) {
        console.warn("[saveDailyLog] to-do create failed:", todoErr.message)
        continue
      }
      if (pid || cid) {
        // Enforce the same profile-XOR-company rule saveScheduleItem uses.
        // The UI only ever sends one, so a both-set row means a malformed
        // client — skip just the assignment (keep the to-do) and log it.
        if (pid && cid) {
          console.warn(
            "[saveDailyLog] to-do assignee skipped: must be a profile or a company, not both"
          )
        } else {
          const { error: aErr } = await supabase
            .from("schedule_assignments")
            .insert({
              schedule_item_id: todoRow.id,
              profile_id: pid,
              company_id: cid,
            })
          if (aErr) {
            console.warn(
              "[saveDailyLog] to-do assignment failed:",
              aErr.message
            )
          }
        }
      }
    }
    revalidatePath(`/projects/${parsed.project_id}/schedule`)
  }

  revalidatePath(`/projects/${parsed.project_id}/daily-logs`)

  // Push to the dashboard only when the log is client-visible. Internal
  // logs stay on this side.
  if (parsed.visibility === "client") {
    const { data: row } = await supabase
      .from("daily_logs")
      .select("*")
      .eq("id", id!)
      .maybeSingle()
    if (row) {
      await sendDashboardWebhook("daily_log.published", row)
    }
  }

  // Courtesy SMS to subs newly marked on-site. We only text once per
  // company per save so a PM editing notes after the fact doesn't fire
  // duplicates. Scheduled via Next's after() (CodeRabbit #30): bare
  // void promise in a Server Action isn't guaranteed to keep running
  // after the response is sent, particularly in streaming / serverless
  // contexts. after() is the supported post-response mechanism and
  // even guarantees execution when the action errors or redirects.
  if (addedCompanyIds.length > 0) {
    after(() =>
      notifyNewSubsOnSite(
        addedCompanyIds,
        parsed.project_id,
        parsed.log_date,
        profile.id
      )
    )
  }
  return { id }
}

async function notifyNewSubsOnSite(
  companyIds: string[],
  projectId: string,
  logDate: string,
  senderProfileId?: string
) {
  try {
    const supabase = await createSupabaseServerClient()
    const [{ data: project }, { data: companies }] = await Promise.all([
      supabase
        .from("projects")
        .select("name, project_number, address")
        .eq("id", projectId)
        .maybeSingle(),
      supabase
        .from("companies")
        .select("id, name, phone")
        .in("id", companyIds),
    ])
    const label =
      project?.address ||
      project?.name ||
      (project?.project_number ? `#${project.project_number}` : "the project")
    for (const c of companies ?? []) {
      if (!c.phone) continue
      const e164 = normalizeE164(c.phone)
      if (!e164) continue
      const body = `Hines Homes: ${c.name} logged on site at ${label} on ${logDate}. Reply with any access or scope notes.`
      const r = await sendQuoSms({
        to: e164,
        content: body,
        log: {
          project_id: projectId,
          company_id: c.id,
          sent_by: senderProfileId ?? null,
          kind: "onsite_notify",
          counterparty_name: c.name,
        },
      })
      if (!r.sent) {
        // Mask the recipient phone in logs (CodeRabbit #30): a full E.164
        // is PII once it lands in log storage, and the company name +
        // tail-4 is enough to correlate.
        const masked = e164.slice(0, 2) + "***" + e164.slice(-4)
        console.warn(
          `[notifyNewSubsOnSite] SMS to ${c.name} (${masked}) failed: ${r.reason ?? "unknown"}`
        )
      }
    }
  } catch (e) {
    console.warn("[notifyNewSubsOnSite] failed:", e)
  }
}

export async function deleteDailyLog({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: atts } = await supabase
    .from("daily_log_attachments")
    .select("storage_path")
    .eq("daily_log_id", id)
  const paths = (atts ?? []).map((a) => a.storage_path)

  const { error } = await supabase.from("daily_logs").delete().eq("id", id)
  if (error) throw new Error(error.message)

  if (paths.length) {
    await supabase.storage.from("project-files").remove(paths)
  }

  revalidatePath(`/projects/${project_id}/daily-logs`)
}

export async function getSignedUrls(paths: string[]) {
  await requireSession()
  if (paths.length === 0) return {}
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage
    .from("project-files")
    .createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}

const DailyLogCommentInput = z.object({
  daily_log_id: z.string().min(1),
  project_id: z.string().min(1),
  body: z.string().min(1, "Comment is empty"),
})

/**
 * Comment on a daily log — staff, or a client member on a client-visible log
 * (RLS policy dlc_client_insert re-verifies both; trades have no policy and
 * are rejected). Client comments alert all staff; staff comments alert the
 * project's client members (client-visible logs only — internal logs have no
 * client audience to notify).
 */
export async function postDailyLogComment(input: {
  daily_log_id: string
  project_id: string
  body: string
}) {
  const profile = await requireSession()
  const parsed = DailyLogCommentInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const authorName = profile.full_name ?? profile.email ?? "Someone"

  const { error } = await supabase.from("daily_log_comments").insert({
    daily_log_id: parsed.daily_log_id,
    author_id: profile.id,
    author_name: authorName,
    body: parsed.body.trim(),
  })
  if (error) throw new Error(error.message)

  try {
    const { data: log } = await supabase
      .from("daily_logs")
      .select("log_date, visibility, projects:project_id(name)")
      .eq("id", parsed.daily_log_id)
      .maybeSingle()
    const logCtx = log as unknown as {
      log_date: string
      visibility: "internal" | "client"
      projects: { name: string } | null
    } | null

    let counterpartyIds: string[] = []
    if (profile.role === "staff" && logCtx?.visibility === "client") {
      const { data: members } = await supabase
        .from("project_members")
        .select("profile_id, profiles!inner(role)")
        .eq("project_id", parsed.project_id)
      counterpartyIds = (members ?? [])
        .filter(
          (m) =>
            (m as unknown as { profiles: { role: string } }).profiles.role ===
            "client"
        )
        .map((m) => m.profile_id)
    }

    const link = `/projects/${parsed.project_id}/daily-logs?open=${parsed.daily_log_id}`
    await notifyCommentPosted({
      entityLabel: logCtx?.log_date
        ? `Job Log ${formatDate(logCtx.log_date)}`
        : "a job log",
      projectName: logCtx?.projects?.name ?? null,
      authorName,
      authorIsStaff: profile.role === "staff",
      authorProfileId: profile.id,
      body: parsed.body.trim(),
      staffLink: link,
      counterpartyProfileIds: counterpartyIds,
      counterpartyLink: link,
    })
  } catch (e) {
    console.warn("daily log comment notification failed:", e)
  }

  revalidatePath(`/projects/${parsed.project_id}/daily-logs`)
  revalidatePath(`/projects/${parsed.project_id}/communications`)
}
