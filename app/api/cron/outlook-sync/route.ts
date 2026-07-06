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

/**
 * Outlook mail sync (Communications hub phase 4). Every 15 minutes, delta-
 * queries the Inbox and Sent Items of each mailbox in
 * OUTLOOK_SYNC_MAILBOXES and stores messages whose counterparty matches a
 * known contact (company email, project client email, client/trade
 * profile). MATCH-BEFORE-STORE: mail that doesn't match a known contact is
 * never written anywhere — a PM's personal messages stay private.
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

export async function GET(req: Request) {
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
  return NextResponse.json({ ok: true, summary })
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
      status: match.status,
      project_id: match.project_id,
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
      meta: { mailbox_folder: folder },
    },
    { onConflict: "source,provider_id", ignoreDuplicates: true }
  )
  if (error) throw new Error(error.message)
  return true
}
