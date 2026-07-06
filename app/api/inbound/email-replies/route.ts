import { NextResponse } from "next/server"
import { Resend, type WebhookEventPayload } from "resend"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { matchCounterparty } from "@/lib/comms/match"
import { notifyStaffOfInbound } from "@/lib/comms/notify"

/**
 * Resend inbound webhook for the Communications hub. Outbound app emails
 * that carry a project context set their Reply-To to
 * `comms+p_<project_id>@<inbound domain>` (see lib/email.ts), so when a
 * client or sub hits Reply, the response routes here, is attributed to the
 * project from the plus-tag (falling back to sender matching), and shows up
 * on the job's Communications tab.
 *
 * Separate endpoint + signing secret (COMMS_RESEND_WEBHOOK_SECRET) from the
 * insurance inbox so either can be rotated independently.
 *
 * Always answers 200 for verified events (Resend retries non-2xx and a
 * poison event must not loop) — same convention as /api/inbound/insurance.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Any local part with a +p_<uuid> tag (works whatever COMMS_INBOUND_EMAIL's
// mailbox name is — comms@, replies@, …).
const PLUS_TAG_RE = /\+p_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY
  const webhookSecret = process.env.COMMS_RESEND_WEBHOOK_SECRET
  if (!apiKey || !webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "RESEND_API_KEY / COMMS_RESEND_WEBHOOK_SECRET not configured" },
      { status: 500 }
    )
  }

  const payload = await req.text()
  const svixId = req.headers.get("svix-id")
  const svixTimestamp = req.headers.get("svix-timestamp")
  const svixSignature = req.headers.get("svix-signature")
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ ok: false, error: "missing signature" }, { status: 401 })
  }

  const resend = new Resend(apiKey)
  let event: WebhookEventPayload
  try {
    event = resend.webhooks.verify({
      payload,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret,
    })
  } catch {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 })
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ ok: true, skipped: event.type })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    console.error("[email-replies] admin client unavailable")
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 500 })
  }

  try {
    const email = event.data as unknown as {
      email_id: string
      from: string
      to: string | string[]
      subject?: string | null
      text?: string | null
      html?: string | null
      attachments?: unknown[]
    }
    const fromAddress = parseAddress(email.from)
    const toList = Array.isArray(email.to) ? email.to : [email.to]

    // Don't double-ingest mail meant for the insurance inbox — that
    // endpoint owns COI processing.
    const insuranceInbox = process.env.INSURANCE_INBOUND_EMAIL?.toLowerCase()
    if (
      insuranceInbox &&
      toList.some((t) => parseAddress(t).toLowerCase() === insuranceInbox)
    ) {
      return NextResponse.json({ ok: true, skipped: "insurance-inbox" })
    }

    // Plus-tag project routing beats sender matching.
    let taggedProjectId: string | null = null
    for (const t of toList) {
      const m = PLUS_TAG_RE.exec(parseAddress(t))
      if (m) {
        taggedProjectId = m[1]
        break
      }
    }
    if (taggedProjectId) {
      const { data: proj } = await admin
        .from("projects")
        .select("id")
        .eq("id", taggedProjectId)
        .maybeSingle()
      if (!proj) taggedProjectId = null
    }

    const match = await matchCounterparty(admin, { email: fromAddress })
    const projectId = taggedProjectId ?? match.project_id
    const status = projectId ? "logged" : match.status

    const bodyText =
      email.text?.trim() ||
      (email.html ? stripHtml(email.html) : "") ||
      "(no text body)"

    const { error } = await admin.from("communications").upsert(
      {
        channel: "email",
        direction: "inbound",
        status,
        project_id: projectId,
        company_id: match.company_id,
        profile_id: match.profile_id,
        from_address: fromAddress,
        to_address: toList.map(parseAddress).join(", "),
        counterparty_name: match.counterparty_name ?? displayName(email.from),
        subject: email.subject ?? null,
        body: bodyText,
        source: "resend_inbound",
        source_kind: "email.received",
        provider_id: email.email_id,
        meta: { attachments: email.attachments?.length ?? 0 },
      },
      { onConflict: "source,provider_id", ignoreDuplicates: true }
    )
    if (error) throw new Error(error.message)

    await notifyStaffOfInbound({
      kind: "email",
      fromName: match.counterparty_name ?? displayName(email.from),
      preview: email.subject || bodyText,
      projectId,
      projectName: projectId ? await projectName(admin, projectId) : null,
    })

    // Ids only in logs — addresses and subjects are PII.
    console.log(`[email-replies] email_id=${email.email_id} matched=${Boolean(projectId)}`)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error(
      "[email-replies] processing failed:",
      e instanceof Error ? e.message : e
    )
    return NextResponse.json({ ok: true, stored: false })
  }
}

/** `"Jane Doe" <jane@x.com>` → `jane@x.com`; bare addresses pass through. */
function parseAddress(input: string): string {
  const m = /<([^>]+)>/.exec(input)
  return (m ? m[1] : input).trim()
}

/** `"Jane Doe" <jane@x.com>` → `Jane Doe`; bare addresses pass through. */
function displayName(input: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(input)
  return (m ? m[1] : parseAddress(input)).trim()
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000)
}

async function projectName(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  projectId: string
): Promise<string | null> {
  const { data } = await admin
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle()
  return data?.name ?? null
}
