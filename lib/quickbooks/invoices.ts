import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { qboGet, QboApiError } from "./client"
import { getQboConnection, getQboConnectionByRealm } from "./storage"
import type { Tables } from "@/lib/db/types"

/**
 * Client-invoice sync for the QBO hybrid model.
 *
 * QuickBooks stays the invoicing system of record — it creates the invoice,
 * emails the client, sends reminders, and takes the payment on Intuit's hosted
 * pay page. This module keeps our qbo_invoices cache in step with it so the
 * portal can list a project's invoices (and their "View & pay" links) without
 * a QBO round-trip per page view. Two entry points feed it:
 *
 *  - syncProjectInvoicesFromQbo — full reconcile of one project's linked
 *    Customer (link-time backfill + the staff "Sync now" button).
 *  - syncSingleInvoice — one invoice, by QBO id (webhook events).
 *
 * All cache writes go through the service-role admin client; qbo_invoices has
 * no insert/update RLS policies on purpose.
 */

export type QboInvoiceRow = Tables<"qbo_invoices">

/** The subset of a QBO Invoice entity we read. */
type QboInvoiceRaw = {
  Id?: string
  DocNumber?: string
  TxnDate?: string
  DueDate?: string
  TotalAmt?: number
  Balance?: number
  CustomerRef?: { value?: string; name?: string }
  CustomerMemo?: { value?: string }
  // Hosted pay-page URL, present only with include=invoiceLink AND online
  // payments enabled on the QBO company.
  InvoiceLink?: string
  PrivateNote?: string
}

const PAGE_SIZE = 1000
const MAX_PAGES = 10 // 10k invoices per customer is far beyond any real job

/** QBO query literals escape with backslashes, not SQL-style doubling. */
function qboEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

/**
 * Every invoice for one QBO Customer, newest first. include=invoiceLink rides
 * on the query so rows come back with their hosted pay link; open invoices
 * that still lack one are re-read individually (bounded) since the read
 * endpoint is the documented home of include=invoiceLink.
 */
async function fetchInvoicesForCustomer(
  orgId: string,
  customerId: string
): Promise<QboInvoiceRaw[]> {
  const out: QboInvoiceRaw[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE + 1
    const query = `SELECT * FROM Invoice WHERE CustomerRef = '${qboEscape(
      customerId
    )}' STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`
    const json = (await qboGet(
      orgId,
      `query?query=${encodeURIComponent(query)}&include=invoiceLink`
    )) as { QueryResponse?: { Invoice?: QboInvoiceRaw[] } }
    const rows = json?.QueryResponse?.Invoice ?? []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }

  // Fallback for open invoices the query didn't return a link for. Bounded so
  // a company without online payments (where every link is legitimately
  // absent) can't turn one sync into hundreds of reads.
  const missing = out.filter(
    (r) => r.Id && !r.InvoiceLink && (r.Balance ?? 0) > 0
  )
  for (const raw of missing.slice(0, 25)) {
    const fresh = await fetchInvoiceById(orgId, raw.Id as string)
    if (fresh?.InvoiceLink) raw.InvoiceLink = fresh.InvoiceLink
  }
  return out
}

/** One invoice by QBO id (with its pay link), or null when it's gone. */
export async function fetchInvoiceById(
  orgId: string,
  qboInvoiceId: string
): Promise<QboInvoiceRaw | null> {
  try {
    const json = (await qboGet(
      orgId,
      `invoice/${encodeURIComponent(qboInvoiceId)}?include=invoiceLink`
    )) as { Invoice?: QboInvoiceRaw }
    return json?.Invoice ?? null
  } catch (e) {
    // A deleted invoice reads back as 400 "Object Not Found" (code 610), not
    // a clean 404 — treat both as gone.
    if (e instanceof QboApiError && (e.status === 404 || e.status === 400)) {
      return null
    }
    throw e
  }
}

/** Derive our cache status from the raw entity (webhook Void op overrides). */
function deriveStatus(raw: QboInvoiceRaw, voided?: boolean): string {
  // QBO keeps a voided invoice as a zeroed entity whose PrivateNote gains a
  // "Voided" marker — the only signal a full-sync read gets.
  if (voided || ((raw.TotalAmt ?? 0) === 0 && /voided/i.test(raw.PrivateNote ?? ""))) {
    return "voided"
  }
  return (raw.Balance ?? 0) <= 0 ? "paid" : "open"
}

function mapInvoice(
  raw: QboInvoiceRaw,
  realmId: string,
  projectId: string,
  opts?: { voided?: boolean }
) {
  return {
    qbo_realm_id: realmId,
    qbo_invoice_id: raw.Id as string,
    project_id: projectId,
    doc_number: raw.DocNumber ?? null,
    txn_date: raw.TxnDate ?? null,
    due_date: raw.DueDate ?? null,
    total: raw.TotalAmt ?? 0,
    balance: raw.Balance ?? 0,
    status: deriveStatus(raw, opts?.voided),
    customer_memo: raw.CustomerMemo?.value ?? null,
    invoice_link: raw.InvoiceLink ?? null,
    last_synced_at: new Date().toISOString(),
  }
}

export type InvoiceSyncResult =
  | { ok: true; synced: number; removed: number }
  | { ok: false; error: string }

/**
 * Full reconcile of one project's invoices against its linked QBO Customer.
 * Upserts everything QBO returns and marks cached rows QBO no longer has as
 * 'deleted' (they stay visible to staff, hidden from clients).
 */
export async function syncProjectInvoicesFromQbo(
  orgId: string,
  project: {
    id: string
    qbo_customer_id: string
  }
): Promise<InvoiceSyncResult> {
  const conn = await getQboConnection(orgId)
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }
  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  let raws: QboInvoiceRaw[]
  try {
    raws = (await fetchInvoicesForCustomer(orgId, project.qbo_customer_id)).filter(
      (r) => r.Id
    )
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const rows = raws.map((r) => mapInvoice(r, conn.realm_id, project.id))
  if (rows.length) {
    const { error } = await admin
      .from("qbo_invoices")
      .upsert(rows, { onConflict: "qbo_realm_id,qbo_invoice_id" })
    if (error) return { ok: false, error: error.message }
  }

  // Rows the reconcile didn't see are gone from QBO (deleted, or the project
  // was re-linked to a different customer) — tombstone rather than delete so
  // staff history survives.
  const seen = new Set(rows.map((r) => r.qbo_invoice_id))
  const { data: cached, error: cacheErr } = await admin
    .from("qbo_invoices")
    .select("id, qbo_invoice_id")
    .eq("project_id", project.id)
    .neq("status", "deleted")
  if (cacheErr) return { ok: false, error: cacheErr.message }
  const stale = (cached ?? []).filter((c) => !seen.has(c.qbo_invoice_id))
  if (stale.length) {
    const { error } = await admin
      .from("qbo_invoices")
      .update({ status: "deleted", last_synced_at: new Date().toISOString() })
      .in(
        "id",
        stale.map((s) => s.id)
      )
    if (error) return { ok: false, error: error.message }
  }

  return { ok: true, synced: rows.length, removed: stale.length }
}

export type SingleInvoiceSync = {
  /** Null when the invoice matched no linked project (not an error). */
  row: QboInvoiceRow | null
  /** Cache balance before this sync — null when the row is new. */
  previousBalance: number | null
  projectName: string | null
}

/**
 * Sync one invoice by QBO id (webhook path). Resolves the owning project via
 * projects.qbo_customer_id; invoices for unlinked customers are ignored. When
 * QBO no longer has the invoice, the cached row is tombstoned. Returns the
 * before/after balance so the caller can detect a payment.
 */
export async function syncSingleInvoice(
  realmId: string,
  qboInvoiceId: string,
  opts?: { voided?: boolean }
): Promise<SingleInvoiceSync | { error: string }> {
  // Webhook path: the event's realm identifies the connection AND the org.
  const conn = await getQboConnectionByRealm(realmId)
  if (!conn) return { error: "QuickBooks is not connected." }
  const admin = createSupabaseAdminClient()
  if (!admin) return { error: "Server storage is not configured." }

  const { data: cached } = await admin
    .from("qbo_invoices")
    .select("*")
    .eq("qbo_realm_id", conn.realm_id)
    .eq("qbo_invoice_id", qboInvoiceId)
    .maybeSingle()

  const raw = await fetchInvoiceById(conn.org_id, qboInvoiceId)
  if (!raw?.Id) {
    if (cached && cached.status !== "deleted") {
      await admin
        .from("qbo_invoices")
        .update({ status: "deleted", last_synced_at: new Date().toISOString() })
        .eq("id", cached.id)
    }
    return { row: null, previousBalance: null, projectName: null }
  }

  // Prefer the cached row's project (stable even if the link was cleared);
  // otherwise resolve via the linked customer.
  let projectId = cached?.project_id ?? null
  let projectName: string | null = null
  const customerId = raw.CustomerRef?.value
  if (!projectId && customerId) {
    // Customer ids are only unique within a realm — scope the lookup to the
    // connection's org so another tenant's identically-numbered customer can
    // never claim this invoice.
    const { data: project } = await admin
      .from("projects")
      .select("id, name")
      .eq("qbo_customer_id", customerId)
      .eq("org_id", conn.org_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    projectId = project?.id ?? null
    projectName = project?.name ?? null
  } else if (projectId) {
    const { data: project } = await admin
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .maybeSingle()
    projectName = project?.name ?? null
  }
  if (!projectId) return { row: null, previousBalance: null, projectName: null }

  const mapped = mapInvoice(raw, conn.realm_id, projectId, opts)
  const { data: rowData, error } = await admin
    .from("qbo_invoices")
    .upsert(mapped, { onConflict: "qbo_realm_id,qbo_invoice_id" })
    .select("*")
    .single()
  if (error) return { error: error.message }

  return {
    row: rowData,
    previousBalance: cached ? Number(cached.balance) : null,
    projectName,
  }
}

/** The QBO Invoice ids a Payment applies to (webhook Payment events). */
export async function invoiceIdsFromPayment(
  orgId: string,
  qboPaymentId: string
): Promise<string[]> {
  type PaymentRaw = {
    Line?: Array<{
      LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>
    }>
  }
  try {
    const json = (await qboGet(
      orgId,
      `payment/${encodeURIComponent(qboPaymentId)}`
    )) as { Payment?: PaymentRaw }
    const ids = new Set<string>()
    for (const line of json?.Payment?.Line ?? []) {
      for (const txn of line.LinkedTxn ?? []) {
        if (txn.TxnType === "Invoice" && txn.TxnId) ids.add(txn.TxnId)
      }
    }
    return [...ids]
  } catch (e) {
    // A deleted payment can't tell us its invoices — the linked invoices'
    // own Update events (balance restored) keep the cache honest.
    if (e instanceof QboApiError && (e.status === 404 || e.status === 400)) {
      return []
    }
    throw e
  }
}
