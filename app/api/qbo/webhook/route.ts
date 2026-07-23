import { createHmac, timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse, after } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getQboConnectionByRealm } from "@/lib/quickbooks/storage"
import {
  invoiceIdsFromPayment,
  syncSingleInvoice,
} from "@/lib/quickbooks/invoices"
import { formatCurrency } from "@/lib/utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Intuit webhook — keeps the qbo_invoices cache fresh and tells staff when a
 * client payment lands. Configured in the Intuit developer portal (same app as
 * the OAuth keys): endpoint {app}/api/qbo/webhook, entities Invoice + Payment,
 * all operations. Verified with QBO_WEBHOOK_VERIFIER_TOKEN (the portal's
 * "Verifier Token", shown next to the endpoint field).
 *
 * Intuit wants a response within ~3 seconds and retries on failure, so the
 * handler verifies the signature, ACKs immediately, and does the QBO reads +
 * cache writes in after(). Events can arrive duplicated or out of order —
 * every write is an idempotent upsert keyed on (realm, invoice id), and the
 * payment notification fires off an observed balance DROP, so a replayed
 * event (same balance) stays silent.
 */

type WebhookEntity = {
  name?: string
  id?: string
  operation?: string
}

type WebhookPayload = {
  eventNotifications?: Array<{
    realmId?: string
    dataChangeEvent?: { entities?: WebhookEntity[] }
  }>
}

/** Base64 HMAC-SHA256 of the raw body, timing-safe compared. */
function verifyIntuitSignature(
  rawBody: string,
  signature: string | null,
  verifierToken: string
): boolean {
  if (!signature) return false
  const expected = createHmac("sha256", verifierToken)
    .update(rawBody)
    .digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signature, "base64")
  } catch {
    return false
  }
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  )
}

export async function POST(req: NextRequest) {
  const verifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN
  if (!verifierToken) {
    console.error("[qbo webhook] QBO_WEBHOOK_VERIFIER_TOKEN not configured")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const rawBody = await req.text()
  if (
    !verifyIntuitSignature(
      rawBody,
      req.headers.get("intuit-signature"),
      verifierToken
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(rawBody) as WebhookPayload
  } catch {
    return NextResponse.json({ ok: true, skipped: "unparseable" })
  }

  const notifications = payload.eventNotifications ?? []
  if (!notifications.length) return NextResponse.json({ ok: true })

  // ACK now, work after the response — Intuit's delivery timeout is short.
  after(async () => {
    try {
      await processNotifications(notifications)
    } catch (e) {
      console.error(
        "[qbo webhook] processing failed:",
        e instanceof Error ? e.message : String(e)
      )
    }
  })

  return NextResponse.json({ ok: true })
}

async function processNotifications(
  notifications: NonNullable<WebhookPayload["eventNotifications"]>
) {
  // One Intuit app serves every org, so a delivery can carry several realms —
  // each realm resolves to its own org's connection and processes under it.
  const byRealm = new Map<string, WebhookEntity[]>()
  for (const notification of notifications) {
    if (!notification.realmId) continue
    const list = byRealm.get(notification.realmId) ?? []
    list.push(...(notification.dataChangeEvent?.entities ?? []))
    byRealm.set(notification.realmId, list)
  }

  for (const [realmId, entities] of byRealm) {
    // Events for a company we're not connected to are none of ours.
    const conn = await getQboConnectionByRealm(realmId)
    if (!conn) continue
    await processRealmEntities(conn.org_id, realmId, entities)
  }
}

async function processRealmEntities(
  orgId: string,
  realmId: string,
  entities: WebhookEntity[]
) {
  // One invoice can be touched by several entities in a batch (its own Update
  // plus a Payment) — collapse to one sync per invoice, keeping the strongest
  // signal (a Void op must not be downgraded by a plain Update).
  const invoiceOps = new Map<string, { voided: boolean }>()

  for (const entity of entities) {
    if (!entity.id) continue
    if (entity.name === "Invoice") {
      const prior = invoiceOps.get(entity.id)
      invoiceOps.set(entity.id, {
        voided: (prior?.voided ?? false) || entity.operation === "Void",
      })
    } else if (entity.name === "Payment") {
      try {
        for (const invoiceId of await invoiceIdsFromPayment(orgId, entity.id)) {
          if (!invoiceOps.has(invoiceId)) {
            invoiceOps.set(invoiceId, { voided: false })
          }
        }
      } catch (e) {
        console.error(
          `[qbo webhook] payment ${entity.id} lookup failed:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  }

  for (const [invoiceId, op] of invoiceOps) {
    try {
      const result = await syncSingleInvoice(realmId, invoiceId, {
        voided: op.voided,
      })
      if ("error" in result) {
        console.error(
          `[qbo webhook] invoice ${invoiceId} sync failed:`,
          result.error
        )
        continue
      }
      const { row, previousBalance, projectName } = result
      // A balance drop on a live invoice = the client paid something. New
      // rows (previousBalance null) stay silent — that's backfill, not news.
      if (
        row &&
        row.status !== "voided" &&
        row.status !== "deleted" &&
        previousBalance != null &&
        Number(row.balance) < previousBalance
      ) {
        await notifyStaffOfPayment({
          orgId,
          projectId: row.project_id,
          projectName,
          docNumber: row.doc_number,
          amountPaid: previousBalance - Number(row.balance),
          balance: Number(row.balance),
        })
      }
    } catch (e) {
      console.error(
        `[qbo webhook] invoice ${invoiceId} failed:`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
}

/**
 * Bell fan-out when a client payment lands. Best-effort. Recipients come from
 * the app_settings key `invoice_payment_recipients` (picked in Settings →
 * QuickBooks); a never-set key falls back to staff with financial_access, and
 * an explicitly saved empty list silences the notification entirely.
 */
async function notifyStaffOfPayment(opts: {
  orgId: string
  projectId: string
  projectName: string | null
  docNumber: string | null
  amountPaid: number
  balance: number
}) {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return
    const recipientIds = await paymentRecipientIds(admin, opts.orgId)
    if (!recipientIds.length) return

    const invoiceLabel = opts.docNumber ? `invoice #${opts.docNumber}` : "an invoice"
    const title = opts.projectName
      ? `${opts.projectName}: payment received`
      : "Payment received"
    const body = `${formatCurrency(opts.amountPaid)} paid on ${invoiceLabel} — ${
      opts.balance <= 0 ? "paid in full" : `${formatCurrency(opts.balance)} remaining`
    }`

    const { error } = await admin.from("notifications").insert(
      recipientIds.map((id) => ({
        recipient_id: id,
        type: "invoice_payment",
        title,
        body,
        link_url: `/projects/${opts.projectId}/invoices`,
        // Lets the notifications trigger honor per-job mutes (0121).
        project_id: opts.projectId,
      }))
    )
    if (error) console.warn("[qbo webhook] notification insert failed:", error.message)
  } catch (e) {
    console.warn(
      "[qbo webhook] notifyStaffOfPayment exception:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

/** Resolve who receives the payment notification (see notifyStaffOfPayment). */
async function paymentRecipientIds(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  orgId: string
): Promise<string[]> {
  // The admin client bypasses RLS, so the org filter is explicit here —
  // app_settings is per-org post-0103 and this must read the setting of the
  // org that owns the QBO connection, never another tenant's.
  const { data: setting } = await admin
    .from("app_settings")
    .select("value")
    .eq("org_id", orgId)
    .eq("key", "invoice_payment_recipients")
    .maybeSingle()

  let configured: string[] | null = null
  if (setting?.value != null) {
    try {
      const parsed: unknown = JSON.parse(setting.value)
      if (Array.isArray(parsed)) {
        configured = parsed.filter((x): x is string => typeof x === "string")
      }
      // An unparseable/malformed value falls through as null → fallback,
      // so a bad save can't silently kill payment notifications.
    } catch {
      configured = null
    }
  }

  // Both branches stay inside the connection's org: a stale or mistyped id
  // in the configured list must never notify another org's staff, and the
  // financial_access fallback means "this org's money people", not everyone's.
  const { data: members } = await admin
    .from("organization_members")
    .select("profile_id")
    .eq("org_id", orgId)
  const memberIds = (members ?? []).map((m) => m.profile_id)
  if (!memberIds.length) return []

  if (configured) {
    if (!configured.length) return []
    // Re-check against live staff so a departed or re-roled profile in a
    // stale list never receives client-payment news.
    const { data: staff } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "staff")
      .in("id", configured.filter((id) => memberIds.includes(id)))
    return (staff ?? []).map((p) => p.id)
  }

  const { data: staff } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "staff")
    .eq("financial_access", true)
    .in("id", memberIds)
  return (staff ?? []).map((p) => p.id)
}
