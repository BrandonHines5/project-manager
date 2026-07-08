import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { verifyQuoSignature } from "@/lib/comms/quo-verify"
import { matchCounterparty } from "@/lib/comms/match"
import { notifyStaffOfInbound } from "@/lib/comms/notify"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Quo (OpenPhone) webhook — captures EVERY text and call on the business
 * number(s), both directions, including texts PMs send from the Quo mobile
 * app that never touch this codebase. Events handled:
 *
 *  - message.received   → inbound SMS (+ staff bell notification)
 *  - message.delivered  → outbound SMS. App-sent texts were already logged
 *    at send time with the same (source='quo', provider_id), so the insert
 *    is ON CONFLICT DO NOTHING — only Quo-app sends create new rows.
 *  - call.completed     → call row (direction, duration, voicemail link)
 *  - call.recording.completed → merges the recording URL onto the call row
 *
 * Always 200 after signature verification (OpenPhone retries on non-2xx and
 * a poison event must not retry forever) — insurance-webhook convention.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.QUO_WEBHOOK_SECRET
  if (!secret) {
    console.error("[quo webhook] QUO_WEBHOOK_SECRET not configured")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const rawBody = await req.text()
  if (!verifyQuoSignature(rawBody, req.headers.get("openphone-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    console.error("[quo webhook] admin client unavailable")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  let event: QuoEvent
  try {
    event = JSON.parse(rawBody) as QuoEvent
  } catch {
    return NextResponse.json({ ok: true, skipped: "unparseable" })
  }
  const type = event?.type ?? ""
  const obj = event?.data?.object
  if (!obj?.id) return NextResponse.json({ ok: true, skipped: type || "no-object" })

  try {
    switch (type) {
      case "message.received":
      case "message.delivered": {
        const inbound = obj.direction === "incoming"
        const counterpartyNumber = inbound ? obj.from : firstTo(obj.to)
        const match = await matchCounterparty(admin, { phone: counterpartyNumber })
        // Which staffer owns the Quo number this text went through — powers
        // per-user attribution for texts typed directly in the Quo app (app-sent
        // texts already carry sent_by and win the ON CONFLICT below).
        const staffProfileId = await staffProfileForQuoNumber(
          admin,
          obj.phoneNumberId,
          inbound ? firstTo(obj.to) : (obj.from ?? null)
        )
        const { error } = await admin.from("communications").upsert(
          {
            channel: "sms",
            direction: inbound ? "inbound" : "outbound",
            status: match.status,
            project_id: match.project_id,
            company_id: match.company_id,
            profile_id: match.profile_id,
            // Outbound = the staffer sent it, so attribute them as sender.
            // Inbound = they only received it; the line owner lives in meta.
            sent_by: inbound ? null : staffProfileId,
            from_address: obj.from ?? null,
            to_address: firstTo(obj.to),
            counterparty_name: match.counterparty_name,
            body: obj.body ?? obj.text ?? "",
            source: "quo",
            source_kind: type,
            provider_id: obj.id,
            occurred_at: obj.createdAt ?? event.createdAt ?? new Date().toISOString(),
            meta: {
              userId: obj.userId ?? null,
              phoneNumberId: obj.phoneNumberId ?? null,
              conversationId: obj.conversationId ?? null,
              quoStaffProfileId: staffProfileId,
            },
          },
          // App-sent texts already hold this (source, provider_id) — keep
          // their richer attribution (sent_by, kind) and skip the insert.
          { onConflict: "source,provider_id", ignoreDuplicates: true }
        )
        if (error) throw new Error(error.message)
        if (inbound) {
          await notifyStaffOfInbound({
            kind: "sms",
            fromName: match.counterparty_name ?? obj.from ?? "Unknown number",
            preview: obj.body ?? obj.text ?? "",
            projectId: match.project_id,
            projectName: await projectName(admin, match.project_id),
          })
        }
        return NextResponse.json({ ok: true })
      }

      case "call.completed": {
        const inbound = obj.direction === "incoming"
        const counterpartyNumber = inbound ? obj.from : firstTo(obj.to)
        const match = await matchCounterparty(admin, { phone: counterpartyNumber })
        const staffProfileId = await staffProfileForQuoNumber(
          admin,
          obj.phoneNumberId,
          inbound ? firstTo(obj.to) : (obj.from ?? null)
        )
        const durationSeconds =
          obj.answeredAt && obj.completedAt
            ? Math.max(
                0,
                Math.round(
                  (Date.parse(obj.completedAt) - Date.parse(obj.answeredAt)) / 1000
                )
              )
            : null
        const voicemailUrl = obj.voicemail?.url ?? null
        const missed = !obj.answeredAt
        const { error } = await admin.from("communications").upsert(
          {
            channel: "call",
            direction: inbound ? "inbound" : "outbound",
            status: match.status,
            project_id: match.project_id,
            company_id: match.company_id,
            profile_id: match.profile_id,
            // Outbound call = the staffer dialed it → attribute as sender.
            sent_by: inbound ? null : staffProfileId,
            from_address: obj.from ?? null,
            to_address: firstTo(obj.to),
            counterparty_name: match.counterparty_name,
            body: voicemailUrl
              ? "Voicemail"
              : missed
                ? "Missed call"
                : "Call",
            source: "quo",
            source_kind: type,
            provider_id: obj.id,
            call_duration_seconds: durationSeconds,
            call_recording_url: voicemailUrl,
            occurred_at: obj.createdAt ?? event.createdAt ?? new Date().toISOString(),
            meta: {
              userId: obj.userId ?? null,
              phoneNumberId: obj.phoneNumberId ?? null,
              conversationId: obj.conversationId ?? null,
              quoStaffProfileId: staffProfileId,
              missed,
              voicemail: Boolean(voicemailUrl),
            },
          },
          { onConflict: "source,provider_id", ignoreDuplicates: true }
        )
        if (error) throw new Error(error.message)
        if (inbound) {
          await notifyStaffOfInbound({
            kind: "call",
            fromName: match.counterparty_name ?? obj.from ?? "Unknown number",
            preview: voicemailUrl
              ? "Left a voicemail"
              : missed
                ? "Missed call"
                : durationSeconds
                  ? `Call, ${Math.round(durationSeconds / 60)} min`
                  : "Call",
            projectId: match.project_id,
            projectName: await projectName(admin, match.project_id),
          })
        }
        return NextResponse.json({ ok: true })
      }

      case "call.recording.completed": {
        // Recording arrives after call.completed; merge the URL onto the
        // existing call row. media shape: [{ url, type }]
        const url = obj.media?.[0]?.url ?? null
        if (!url) return NextResponse.json({ ok: true, skipped: "no-recording-url" })
        const { error } = await admin
          .from("communications")
          .update({ call_recording_url: url })
          .eq("source", "quo")
          .eq("provider_id", obj.id)
        if (error) throw new Error(error.message)
        return NextResponse.json({ ok: true })
      }

      default:
        return NextResponse.json({ ok: true, skipped: type })
    }
  } catch (e) {
    // Log and 200 — a bad row must not put OpenPhone into a retry loop.
    console.error(
      `[quo webhook] ${type} processing failed:`,
      e instanceof Error ? e.message : e
    )
    return NextResponse.json({ ok: true, stored: false })
  }
}

type QuoEvent = {
  id?: string
  type?: string
  createdAt?: string
  data?: {
    object?: {
      id?: string
      from?: string
      to?: string | string[]
      direction?: "incoming" | "outgoing"
      body?: string
      text?: string
      createdAt?: string
      answeredAt?: string | null
      completedAt?: string | null
      voicemail?: { url?: string; duration?: number; type?: string } | null
      media?: { url?: string; type?: string }[]
      userId?: string
      phoneNumberId?: string
      conversationId?: string
    }
  }
}

function firstTo(to: string | string[] | undefined): string | null {
  if (!to) return null
  return Array.isArray(to) ? (to[0] ?? null) : to
}

/**
 * The staff profile that owns the business-side Quo number an event went
 * through — matched first on the stable phone-number id, then its E.164.
 * Returns null when the number isn't assigned to anyone (the shared line, or
 * an unmapped number), which just leaves the row unattributed.
 */
async function staffProfileForQuoNumber(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  phoneNumberId: string | undefined,
  e164: string | null
): Promise<string | null> {
  if (phoneNumberId) {
    const { data } = await admin
      .from("profiles")
      .select("id")
      .eq("quo_phone_number_id", phoneNumberId)
      .maybeSingle()
    if (data?.id) return data.id
  }
  if (e164) {
    const { data } = await admin
      .from("profiles")
      .select("id")
      .eq("quo_phone_number", e164)
      .maybeSingle()
    if (data?.id) return data.id
  }
  return null
}

async function projectName(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  projectId: string | null
): Promise<string | null> {
  if (!projectId) return null
  const { data } = await admin
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle()
  return data?.name ?? null
}
