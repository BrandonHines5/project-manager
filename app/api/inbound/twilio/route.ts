import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { appUrl } from "@/lib/email"
import { verifyTwilioSignature } from "@/lib/comms/twilio-verify"
import { orgForTwilioNumber } from "@/lib/twilio"
import { matchCounterparty, scopeMatchToOrg } from "@/lib/comms/match"
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
    // Fail closed: a provisioned Twilio number is always claimed by exactly one
    // org. If we can't resolve it, DROP the message rather than writing it under
    // the communications bridge default (which would leak into Hines' feed).
    if (!orgId) {
      console.warn(`[twilio webhook] no org owns ${to}; dropping message`)
      return twiml()
    }

    // matchCounterparty is global (a sub's phone can appear in several orgs'
    // directories), so scope the result to THIS number's org — cross-org
    // project/company/profile links are dropped, keeping the message logged
    // under the right tenant, just unattributed. A scope-lookup FAILURE is
    // retryable (throw → 503) — a transient error must not silently unlink.
    const scoped = await scopeMatchToOrg(
      admin,
      await matchCounterparty(admin, { phone: from }),
      orgId
    )
    if (scoped.lookupFailed) throw new RetryableDbError("org scope lookup failed")
    const match = scoped.match
    const numMedia = parseInt(params.NumMedia || "0", 10) || 0
    const body = params.Body?.trim() || (numMedia > 0 ? "[media]" : "")

    const { error } = await admin.from("communications").upsert(
      {
        channel: "sms",
        direction: "inbound",
        org_id: orgId,
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
    if (error) throw new RetryableDbError(error.message)

    await notifyStaffOfInbound({
      kind: "sms",
      fromName: match.counterparty_name ?? from,
      preview: body,
      projectId: match.project_id,
      projectName: await projectName(admin, match.project_id),
      orgId,
    })
    return twiml()
  } catch (e) {
    // A transient DB failure (scope lookup or the write) is retryable — return
    // 503 so Twilio redelivers (the upsert dedups on (source, provider_id), so
    // a retry is idempotent) rather than dropping/losing the message.
    if (e instanceof RetryableDbError) {
      console.error("[twilio webhook] transient DB failure; requesting retry:", e.message)
      return NextResponse.json({ error: "database unavailable" }, { status: 503 })
    }
    // Otherwise log and 200 — a poison row must not loop Twilio's retries.
    console.error(
      "[twilio webhook] processing failed:",
      e instanceof Error ? e.message : e
    )
    return twiml()
  }
}

/** A transient DB failure (scope lookup OR the communications write) — the
 *  route returns a retryable 503 for these rather than dropping/losing the
 *  message and 200-ing (no retry). Genuine no-match / poison rows still 200.
 *  (The org-scoping itself is the shared lib/comms/match.ts:scopeMatchToOrg.) */
class RetryableDbError extends Error {}

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
