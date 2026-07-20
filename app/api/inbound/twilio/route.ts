import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { appUrl } from "@/lib/email"
import { verifyTwilioSignature } from "@/lib/comms/twilio-verify"
import { orgForTwilioNumber } from "@/lib/twilio"
import { matchCounterparty } from "@/lib/comms/match"
import { notifyStaffOfInbound } from "@/lib/comms/notify"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

// Empty TwiML — Twilio expects XML back on the SmsUrl; an empty <Response>
// means "no auto-reply". Any 2xx stops Twilio retrying.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
function twiml() {
  return new NextResponse(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  })
}

/**
 * Inbound SMS webhook for the platform-managed Twilio numbers (builder orgs).
 * The OpenPhone/Quo counterpart is /api/inbound/quo, unchanged for Hines.
 *
 * Twilio POSTs application/x-www-form-urlencoded on each incoming message. We
 * resolve the tenant from the `To` number (the org's provisioned line), match
 * the sender to a project/company/client, and log the text to communications.
 * Signature-verified against the canonical SmsUrl; always 200 after that so a
 * poison event can't loop Twilio's retries.
 */
export async function POST(req: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    console.error("[twilio webhook] TWILIO_AUTH_TOKEN not configured")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const rawBody = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v

  if (
    !verifyTwilioSignature(
      appUrl("/api/inbound/twilio"),
      params,
      req.headers.get("x-twilio-signature"),
      authToken
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    console.error("[twilio webhook] admin client unavailable")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const messageSid = params.MessageSid || params.SmsSid || null
  const from = params.From || null
  const to = params.To || null
  // Twilio only calls the SmsUrl for INCOMING messages (we set no
  // StatusCallback), so every hit here is inbound. Guard on the essentials.
  if (!messageSid || !from || !to) {
    return twiml()
  }

  try {
    const orgId = await orgForTwilioNumber(admin, to)
    const match = await matchCounterparty(admin, { phone: from })
    const numMedia = parseInt(params.NumMedia || "0", 10) || 0
    const body = params.Body?.trim() || (numMedia > 0 ? "[media]" : "")

    const { error } = await admin.from("communications").upsert(
      {
        channel: "sms",
        direction: "inbound",
        // Stamp the org that owns this Twilio number; a number is always
        // claimed by exactly one org, so this normally resolves.
        ...(orgId ? { org_id: orgId } : {}),
        // Like the Quo path: never queued for manual placement — auto-filed to
        // a job only when the matcher is confident, otherwise global + searchable.
        status: "logged",
        project_id: match.project_id,
        company_id: match.company_id,
        profile_id: match.profile_id,
        from_address: from,
        to_address: to,
        counterparty_name: match.counterparty_name,
        body,
        source: "twilio",
        source_kind: "message.received",
        provider_id: messageSid,
        meta: {
          numMedia,
          messagingServiceSid: params.MessagingServiceSid ?? null,
        },
      },
      // Twilio can retry a delivery; dedup on (source, provider_id) like Quo.
      { onConflict: "source,provider_id", ignoreDuplicates: true }
    )
    if (error) throw new Error(error.message)

    await notifyStaffOfInbound({
      kind: "sms",
      fromName: match.counterparty_name ?? from,
      preview: body,
      projectId: match.project_id,
      projectName: await projectName(admin, match.project_id),
    })
    return twiml()
  } catch (e) {
    // Log and 200 — a bad row must not put Twilio into a retry loop.
    console.error(
      "[twilio webhook] processing failed:",
      e instanceof Error ? e.message : e
    )
    return twiml()
  }
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
