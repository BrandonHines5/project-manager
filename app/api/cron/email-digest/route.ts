import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { sendEmail, appUrl } from "@/lib/email"

/**
 * Daily email digest endpoint. Fired by Vercel Cron (see vercel.json).
 *
 * For every profile whose email_digest_pref = 'daily':
 *   1. Pull every notification with email_sent_at IS NULL since
 *      last_digest_at (or all-time on the first run).
 *   2. If there are any, format them into a single multi-section email
 *      and ship via Resend.
 *   3. Stamp email_sent_at = now() on every row included, and bump
 *      last_digest_at on the profile so the next run starts cleanly.
 *
 * Auth: requires Authorization: Bearer ${CRON_SECRET}. Vercel Cron sends
 * this header automatically when CRON_SECRET is set on the project.
 * Without the header the route 401s so a stray fetch from anywhere else
 * can't trigger a send.
 *
 * Uses the service-role client because cron has no user session, and we
 * need to span all profiles. RLS is bypassed deliberately on this path —
 * the rest of the request body is server-only.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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

  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "SUPABASE_SERVICE_ROLE_KEY not configured — cron needs admin rights to span profiles",
      },
      { status: 500 }
    )
  }

  const { data: profiles, error: profErr } = await supabase
    .from("profiles")
    .select("id, email, full_name, last_digest_at")
    .eq("email_digest_pref", "daily")
    .not("email", "is", null)
  if (profErr) {
    return NextResponse.json(
      { ok: false, error: profErr.message },
      { status: 500 }
    )
  }

  const summary: {
    profile_id: string
    notifications: number
    sent: boolean
    reason?: string
  }[] = []

  for (const p of profiles ?? []) {
    if (!p.email) continue
    const sinceISO = p.last_digest_at ?? "1970-01-01T00:00:00Z"
    const { data: notifs, error: nErr } = await supabase
      .from("notifications")
      .select("title, body, link_url, type, created_at")
      .eq("recipient_id", p.id)
      .is("email_sent_at", null)
      .gt("created_at", sinceISO)
      .order("created_at", { ascending: true })
      .limit(200)
    if (nErr) {
      summary.push({
        profile_id: p.id,
        notifications: 0,
        sent: false,
        reason: nErr.message,
      })
      continue
    }
    if (!notifs || notifs.length === 0) {
      summary.push({ profile_id: p.id, notifications: 0, sent: false })
      continue
    }

    // Group by type so the email reads cleanly ("3 schedule assignments,
    // 2 decision follow-ups"). Within each group we sort newest first
    // so the most pressing items lead.
    const groups = new Map<string, typeof notifs>()
    for (const n of notifs) {
      const list = groups.get(n.type) ?? []
      list.push(n)
      groups.set(n.type, list)
    }
    const sections = Array.from(groups.entries())
      .map(([type, items]) => {
        const heading = humanType(type)
        const lines = items
          .slice()
          .reverse()
          .map(
            (i) =>
              `• ${i.title}${i.body ? ` — ${i.body}` : ""}${
                i.link_url ? ` (${appUrl(i.link_url)})` : ""
              }`
          )
          .join("\n")
        return `${heading} (${items.length})\n${lines}`
      })
      .join("\n\n")

    const greeting = p.full_name
      ? `Hi ${p.full_name.split(" ")[0]},`
      : "Hi,"
    const text = `${greeting}\n\nHere's what landed on your Hines Homes plate since the last digest:\n\n${sections}\n\nOpen the app: ${appUrl("/projects")}`

    const result = await sendEmail({
      to: p.email,
      subject: `Daily digest — ${notifs.length} update${
        notifs.length === 1 ? "" : "s"
      }`,
      text,
    })

    if (result.sent) {
      // Stamp the notifications and bump the profile in two writes so
      // a partial Resend failure doesn't leave a profile with new
      // last_digest_at but un-stamped notifications (we'd skip them
      // forever on the next run).
      const ids = notifs.map((_, i) => i)
      void ids
      const idList = (
        await supabase
          .from("notifications")
          .select("id")
          .eq("recipient_id", p.id)
          .is("email_sent_at", null)
          .gt("created_at", sinceISO)
          .order("created_at", { ascending: true })
          .limit(200)
      ).data?.map((r) => r.id) ?? []
      const nowIso = new Date().toISOString()
      if (idList.length) {
        await supabase
          .from("notifications")
          .update({ email_sent_at: nowIso })
          .in("id", idList)
      }
      await supabase
        .from("profiles")
        .update({ last_digest_at: nowIso })
        .eq("id", p.id)
      summary.push({
        profile_id: p.id,
        notifications: notifs.length,
        sent: true,
      })
    } else {
      summary.push({
        profile_id: p.id,
        notifications: notifs.length,
        sent: false,
        reason: result.reason,
      })
    }
  }

  return NextResponse.json({ ok: true, summary }, { status: 200 })
}

function humanType(type: string): string {
  switch (type) {
    case "schedule_assignment":
      return "Schedule assignments"
    case "decision_followup":
      return "Decision follow-ups"
    default:
      return type
        .split("_")
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join(" ")
  }
}
