import { NextResponse } from "next/server"
import { Resend, type WebhookEventPayload } from "resend"
import {
  ingestInsuranceDocument,
  parseEmailAddress,
} from "@/lib/insurance/ingest"
import { isExtractableType } from "@/lib/insurance/extract"

/**
 * Resend inbound-email webhook. Point a Resend webhook (event
 * `email.received`) at this route and give the receiving address (e.g.
 * insurance@updates.hineshomes.com) to subs — or set an Outlook rule that
 * auto-forwards insurance emails to it. Each PDF/image attachment is pulled
 * down via Resend's attachment API and run through the COI ingest pipeline
 * (store → Claude extraction → policy rows).
 *
 * Auth: Resend signs webhooks with Svix headers; `resend.webhooks.verify`
 * checks the signature against RESEND_WEBHOOK_SECRET (the `whsec_…` signing
 * secret shown when the webhook endpoint is created in the Resend
 * dashboard). Unsigned/invalid requests get a 401.
 *
 * Always answers 200 for verified events — even when ingestion of an
 * individual attachment fails — because Resend retries non-2xx responses
 * and a poison attachment would otherwise be re-processed forever. Failures
 * are recorded on the insurance_documents row for the staff review queue.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// Claude extraction of a multi-attachment email can take a few minutes.
export const maxDuration = 300

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
  if (!apiKey || !webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "RESEND_API_KEY / RESEND_WEBHOOK_SECRET not configured" },
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

  const email = event.data

  // Once the domain receives non-insurance mail (comms replies with PDF
  // attachments, say), only process messages actually addressed to the
  // insurance inbox — otherwise a client's reply with a contract PDF would
  // be ingested as a COI. No-op when INSURANCE_INBOUND_EMAIL is unset or
  // this webhook is scoped to a single address in Resend.
  const insuranceInbox = process.env.INSURANCE_INBOUND_EMAIL?.toLowerCase()
  if (insuranceInbox) {
    const toList = (Array.isArray(email.to) ? email.to : [email.to]).filter(
      (t): t is string => typeof t === "string"
    )
    const addressed = toList.some(
      (t) => (parseEmailAddress(t) ?? t).toLowerCase() === insuranceInbox
    )
    if (!addressed) {
      return NextResponse.json({ ok: true, skipped: "not-insurance-inbox" })
    }
  }

  const from = parseEmailAddress(email.from) ?? email.from
  const summary: { attachment: string; status: string }[] = []

  for (const att of email.attachments ?? []) {
    const name = att.filename ?? "attachment"
    if (!isExtractableType(att.content_type)) {
      summary.push({ attachment: name, status: "skipped (not pdf/image)" })
      continue
    }
    try {
      // The webhook only carries attachment metadata; the bytes come from
      // the attachment endpoint's short-lived signed download_url.
      const { data: meta, error } = await resend.emails.receiving.attachments.get({
        emailId: email.email_id,
        id: att.id,
      })
      if (error || !meta) {
        summary.push({ attachment: name, status: `metadata failed: ${error?.message}` })
        continue
      }
      const res = await fetch(meta.download_url)
      if (!res.ok) {
        summary.push({ attachment: name, status: `download failed: HTTP ${res.status}` })
        continue
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        summary.push({ attachment: name, status: "skipped (too large)" })
        continue
      }
      const result = await ingestInsuranceDocument({
        bytes,
        fileName: name,
        fileType: att.content_type,
        fileSize: bytes.length,
        source: "email",
        emailFrom: from,
        emailSubject: email.subject,
      })
      summary.push({
        attachment: name,
        status: result.ok ? result.status : `error: ${result.error}`,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[insurance-inbound] ${name}:`, msg)
      summary.push({ attachment: name, status: `error: ${msg}` })
    }
  }

  // Log ids/counts only — sender addresses, subjects, and filenames are PII
  // that doesn't belong in platform logs. The document rows carry the detail.
  const failed = summary.filter((s) => s.status.startsWith("error")).length
  console.log(
    `[insurance-inbound] email_id=${email.email_id} attachments=${summary.length} failed=${failed}`
  )
  return NextResponse.json({ ok: true, summary })
}
