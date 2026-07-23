import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import {
  fetchDeltaPage,
  getGraphToken,
  graphConfigured,
  initialDeltaUrl,
  type GraphMessage,
} from "@/lib/comms/graph"
import { matchCounterparty } from "@/lib/comms/match"
import {
  classifyEmailJobs,
  type EmailForMatching,
  type JobForMatching,
} from "@/lib/ai/email-job-match"
import { LEGACY_ORG_ID } from "@/lib/org"

/**
 * Outlook mail sync (Communications hub phase 4). Every 15 minutes, delta-
 * queries the Inbox and Sent Items of each mailbox in
 * OUTLOOK_SYNC_MAILBOXES and stores messages whose counterparty matches a
 * known contact (company email, project client email, client/trade
 * profile). MATCH-BEFORE-STORE: mail that doesn't match a known contact is
 * never written anywhere — a PM's personal messages stay private.
 *
 * JOB ATTRIBUTION IS AI-ONLY: the engagement heuristics that place phone
 * traffic misfile email (a utility company corresponds about many jobs
 * while formally engaged on one), so a stored message lands with NO
 * project_id — the heuristic's guess rides along in meta.suggested_project
 * as evidence. A classification sweep at the end of each run (batched
 * Claude call, content-based, conservative) files every not-yet-classified
 * sync row: a confident match stamps project_id and marks
 * meta.job_match='ai'; anything ambiguous stays global-hub-only with
 * meta.job_match='none'. Manual "File to job" marks 'manual' and is never
 * revisited. The sweep also drains the pre-AI backlog, correcting rows the
 * old heuristics stamped.
 *
 * Dedup on (source='outlook', provider_id=internetMessageId) — the same
 * message seen from two synced mailboxes lands once. No bell notifications
 * from this path: the mail is already in someone's inbox; the hub is the
 * record, not an alert.
 *
 * Auth: Vercel Cron bearer CRON_SECRET (same as the other crons). Graceful
 * no-op when the MS_* env vars are unset.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

// Page cap per (mailbox, folder) per run — a large first sync just resumes
// where it left off next tick (the stored link is a nextLink).
const MAX_PAGES = 10
const FOLDERS = ["inbox", "sentitems"] as const

// Classification sweep sizing. Batches are small enough that one model call
// stays fast; the wall-clock budget leaves headroom inside maxDuration for
// the delta sync that ran first. Whatever doesn't fit waits 15 minutes.
const SWEEP_BATCH = 20
const SWEEP_MAX_ROWS = 200
const SWEEP_DEADLINE_MS = 240_000

export async function GET(req: Request) {
  const startedAt = Date.now()
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    )
  }
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 401 })
  }

  const mailboxes = (process.env.OUTLOOK_SYNC_MAILBOXES ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
  if (!graphConfigured() || mailboxes.length === 0) {
    return NextResponse.json({ ok: true, skipped: "outlook sync not configured" })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 }
    )
  }
  const token = await getGraphToken()
  if (!token) {
    return NextResponse.json({ ok: false, error: "graph token failed" }, { status: 500 })
  }

  const summary: { mailbox: string; folder: string; seen: number; stored: number }[] = []

  for (const mailbox of mailboxes) {
    // The mailbox owner's profile (sender attribution for Sent Items).
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", mailbox)
      .maybeSingle()

    for (const folder of FOLDERS) {
      const { data: state } = await admin
        .from("outlook_sync_state")
        .select("delta_link")
        .eq("mailbox", mailbox)
        .eq("folder", folder)
        .maybeSingle()

      let url = state?.delta_link || initialDeltaUrl(mailbox, folder)
      let seen = 0
      let stored = 0
      let lastLink: string | null = null

      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchDeltaPage(token, url)
        if (!result) break // transient Graph error — retry from the same link next run
        seen += result.messages.length
        for (const msg of result.messages) {
          try {
            if (await storeIfMatched(admin, msg, folder, owner?.id ?? null)) stored++
          } catch (e) {
            console.error(
              "[outlook-sync] store failed:",
              e instanceof Error ? e.message : e
            )
          }
        }
        lastLink = result.deltaLink ?? result.nextLink
        if (result.deltaLink || !result.nextLink) break
        url = result.nextLink
      }

      if (lastLink) {
        await admin.from("outlook_sync_state").upsert(
          {
            mailbox,
            folder,
            delta_link: lastLink,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "mailbox,folder" }
        )
      }
      summary.push({ mailbox, folder, seen, stored })
    }
  }

  console.log(
    `[outlook-sync] ${summary
      .map((s) => `${s.mailbox}/${s.folder}: ${s.stored}/${s.seen}`)
      .join(", ")}`
  )

  // Phase 2: file not-yet-classified sync rows to jobs (or to none).
  const sweep = await classifyUnfiledEmails(admin, startedAt)

  return NextResponse.json({ ok: true, summary, sweep })
}

/**
 * The AI filing sweep. Picks up every sync-created row that hasn't been
 * classified yet (meta.job_match absent — covers rows this run just stored
 * AND the pre-AI backlog), classifies them in batches against the legacy
 * org's job list, and writes the verdicts. Rows the model skipped or that
 * error out keep meta.job_match unset, so the next run retries them.
 */
async function classifyUnfiledEmails(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  startedAt: number
): Promise<{ classified: number; filed: number; skipped: string | null }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { classified: 0, filed: 0, skipped: "no ANTHROPIC_API_KEY" }
  }

  // The Outlook sync is legacy-org infrastructure (Hines' Microsoft tenant),
  // so the candidate job list is the legacy org's real jobs.
  const { data: jobs, error: jobsErr } = await admin
    .from("projects")
    .select("id, project_number, name, address, client_name, client_name_2")
    .eq("org_id", LEGACY_ORG_ID)
    .eq("is_template", false)
  if (jobsErr || !jobs?.length) {
    return { classified: 0, filed: 0, skipped: jobsErr?.message ?? "no jobs" }
  }
  const jobList: JobForMatching[] = jobs

  const { data: rows, error: rowsErr } = await admin
    .from("communications")
    .select(
      "id, direction, subject, body, counterparty_name, project_id, meta"
    )
    .eq("source", "outlook")
    .in("source_kind", ["outlook.inbox", "outlook.sentitems"])
    .is("meta->>job_match", null)
    .neq("status", "ignored")
    .order("occurred_at", { ascending: false })
    .limit(SWEEP_MAX_ROWS)
  if (rowsErr || !rows?.length) {
    return { classified: 0, filed: 0, skipped: rowsErr?.message ?? null }
  }

  let classified = 0
  let filed = 0
  for (let i = 0; i < rows.length; i += SWEEP_BATCH) {
    if (Date.now() - startedAt > SWEEP_DEADLINE_MS) break
    const batch = rows.slice(i, i + SWEEP_BATCH)
    const emails: EmailForMatching[] = batch.map((r) => {
      const meta = (r.meta ?? {}) as Record<string, unknown>
      const suggested =
        typeof meta.suggested_project === "string"
          ? meta.suggested_project
          : // Pre-AI backlog rows carry the heuristic guess ON the row.
            r.project_id
      return {
        key: r.id,
        direction: r.direction === "outbound" ? "outbound" : "inbound",
        subject: r.subject,
        body_preview: r.body,
        counterparty_name: r.counterparty_name,
        suggested_project_id: suggested ?? null,
      }
    })

    let verdicts: Map<string, string | null>
    try {
      verdicts = await classifyEmailJobs(emails, jobList)
    } catch (e) {
      console.warn(
        "[outlook-sync] classify batch failed (rows retry next run):",
        e instanceof Error ? e.message : e
      )
      break
    }

    for (const r of batch) {
      if (!verdicts.has(r.id)) continue
      const projectId = verdicts.get(r.id) ?? null
      const meta = {
        ...((r.meta ?? {}) as Record<string, unknown>),
        job_match: projectId ? "ai" : "none",
      }
      const { error: upErr } = await admin
        .from("communications")
        .update({
          project_id: projectId,
          meta,
          // A filed row must be visible on the job tab (which requires
          // status 'logged'); an unfiled one drops any heuristic-era
          // needs_review nagging and lives in the global hub like phone
          // traffic does.
          status: "logged",
        })
        .eq("id", r.id)
        // Re-check the claim under concurrency: if staff manually filed the
        // row while this batch was at the model, job_match is 'manual' now
        // and the verdict must not clobber it.
        .is("meta->>job_match", null)
      if (upErr) {
        console.warn("[outlook-sync] sweep update failed:", upErr.message)
        continue
      }
      classified++
      if (projectId) filed++
    }
  }
  console.log(
    `[outlook-sync] sweep classified ${classified} (${filed} filed to jobs)`
  )
  return { classified, filed, skipped: null }
}

/**
 * Store a message when its counterparty matches a known contact. Inbox mail
 * matches on the sender; Sent Items on each recipient (first match wins).
 * Returns whether a row was written.
 */
async function storeIfMatched(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  msg: GraphMessage,
  folder: (typeof FOLDERS)[number],
  ownerProfileId: string | null
): Promise<boolean> {
  if (msg["@removed"] || !msg.internetMessageId) return false
  const inbound = folder === "inbox"
  const fromAddress = msg.from?.emailAddress?.address ?? null
  const toAddresses = (msg.toRecipients ?? [])
    .map((r) => r.emailAddress?.address)
    .filter((a): a is string => Boolean(a))

  const candidates = inbound ? (fromAddress ? [fromAddress] : []) : toAddresses
  let match: Awaited<ReturnType<typeof matchCounterparty>> | null = null
  for (const address of candidates) {
    const m = await matchCounterparty(admin, { email: address })
    if (m.company_id || m.profile_id || m.project_id) {
      match = m
      break
    }
  }
  // Match-before-store: unknown counterparty → never persisted.
  if (!match) return false

  const { error } = await admin.from("communications").upsert(
    {
      channel: "email",
      direction: inbound ? "inbound" : "outbound",
      // Like the Quo webhook, synced mail is never queued for manual
      // placement — it lands global-hub-visible immediately. Job filing is
      // the AI sweep's call alone: the engagement heuristic's guess rides
      // along as evidence (meta.suggested_project), never as a stamp.
      status: "logged",
      project_id: null,
      company_id: match.company_id,
      profile_id: match.profile_id,
      sent_by: inbound ? null : ownerProfileId,
      from_address: fromAddress,
      to_address: toAddresses.join(", ") || null,
      counterparty_name:
        match.counterparty_name ??
        (inbound ? msg.from?.emailAddress?.name : msg.toRecipients?.[0]?.emailAddress?.name) ??
        null,
      subject: msg.subject ?? null,
      body: msg.bodyPreview ?? "",
      source: "outlook",
      source_kind: `outlook.${folder}`,
      provider_id: msg.internetMessageId,
      occurred_at:
        (inbound ? msg.receivedDateTime : msg.sentDateTime) ??
        msg.receivedDateTime ??
        new Date().toISOString(),
      meta: {
        mailbox_folder: folder,
        ...(match.project_id ? { suggested_project: match.project_id } : {}),
      },
    },
    { onConflict: "source,provider_id", ignoreDuplicates: true }
  )
  if (error) throw new Error(error.message)
  return true
}
