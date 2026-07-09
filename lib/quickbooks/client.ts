import "server-only"
import { QBO_MINOR_VERSION, qboApiBase } from "./config"
import { getValidAccessToken } from "./oauth"

/**
 * Thin authenticated fetch wrapper for the QBO Accounting API. Resolves a valid
 * access token (refreshing if needed), targets the connected realm, and retries
 * once on a 401 after forcing a token refresh. Returns parsed JSON or throws a
 * QboApiError the callers surface as a typed result.
 *
 * Phase 1 exposes read-only helpers (CompanyInfo + reference data + PO lookup)
 * used by the connection diagnostic. The PurchaseOrder create/update path lands
 * in Phase 2 once we've inspected how the connected file structures its POs.
 */

export class QboApiError extends Error {
  status: number
  body: string
  /**
   * Intuit transaction id (`intuit_tid` response header). Intuit support uses
   * it to trace a specific request when troubleshooting, so we capture and log
   * it on every failure.
   */
  intuitTid: string | null
  constructor(status: number, body: string, intuitTid: string | null = null) {
    super(`QBO API ${status} (tid ${intuitTid ?? "?"}): ${body.slice(0, 300)}`)
    this.name = "QboApiError"
    this.status = status
    this.body = body
    this.intuitTid = intuitTid
  }
}

export class QboNotConnectedError extends Error {
  constructor() {
    super("QuickBooks is not connected")
    this.name = "QboNotConnectedError"
  }
}

async function qboRequest(
  path: string,
  init: RequestInit,
  attempt = 0
): Promise<unknown> {
  const auth = await getValidAccessToken(attempt > 0)
  if (!auth) throw new QboNotConnectedError()

  const base = qboApiBase(auth.connection.environment)
  const sep = path.includes("?") ? "&" : "?"
  const url = `${base}/v3/company/${auth.realmId}/${path}${sep}minorversion=${QBO_MINOR_VERSION}`

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })

  // One retry on 401 (token invalidated early) — force a refresh, then give up.
  if (res.status === 401 && attempt === 0) {
    return qboRequest(path, init, 1)
  }
  const text = await res.text().catch(() => "")
  const intuitTid = res.headers.get("intuit_tid")
  if (!res.ok) {
    console.error(`[qbo] request failed (${res.status}, tid=${intuitTid ?? "?"}): ${text.slice(0, 300)}`)
    throw new QboApiError(res.status, text, intuitTid)
  }
  return text ? JSON.parse(text) : null
}

/** GET a QBO entity/query path. */
export function qboGet(path: string): Promise<unknown> {
  return qboRequest(path, { method: "GET" })
}

/** Run a QBO SQL-like query (SELECT ... FROM Entity WHERE ...). */
export function qboQuery(query: string): Promise<unknown> {
  return qboGet(`query?query=${encodeURIComponent(query)}`)
}

export type QboRef = { value?: string; name?: string }

export type QboCompanyInfo = {
  CompanyName?: string
  LegalName?: string
  Country?: string
}

/** The connected company's profile (name shown in the settings UI). */
export async function getCompanyInfo(): Promise<QboCompanyInfo | null> {
  const json = (await qboQuery("SELECT * FROM CompanyInfo")) as {
    QueryResponse?: { CompanyInfo?: QboCompanyInfo[] }
  }
  return json?.QueryResponse?.CompanyInfo?.[0] ?? null
}

/**
 * Fetch reference data + an example PurchaseOrder for the connection
 * diagnostic. Every field is optional; a failing sub-query is reported rather
 * than aborting the whole diagnostic.
 */
export async function fetchDiagnosticSnapshot(exampleDocNumber?: string): Promise<{
  company: QboCompanyInfo | null
  vendors: unknown[]
  accounts: unknown[]
  items: unknown[]
  examplePurchaseOrder: unknown | null
  errors: Record<string, string>
}> {
  const errors: Record<string, string> = {}

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      errors[label] = e instanceof Error ? e.message : String(e)
      return fallback
    }
  }

  const company = await safe("company", () => getCompanyInfo(), null)
  const vendors = await safe(
    "vendors",
    async () =>
      ((await qboQuery("SELECT * FROM Vendor WHERE Active = true MAXRESULTS 10")) as {
        QueryResponse?: { Vendor?: unknown[] }
      })?.QueryResponse?.Vendor ?? [],
    [] as unknown[]
  )
  const accounts = await safe(
    "accounts",
    async () =>
      ((await qboQuery(
        "SELECT * FROM Account WHERE AccountType IN ('Expense','Cost of Goods Sold','Accounts Payable') MAXRESULTS 20"
      )) as { QueryResponse?: { Account?: unknown[] } })?.QueryResponse?.Account ?? [],
    [] as unknown[]
  )
  const items = await safe(
    "items",
    async () =>
      ((await qboQuery("SELECT * FROM Item MAXRESULTS 20")) as {
        QueryResponse?: { Item?: unknown[] }
      })?.QueryResponse?.Item ?? [],
    [] as unknown[]
  )
  const examplePurchaseOrder = await safe(
    "purchaseOrder",
    async () => {
      const where = exampleDocNumber
        ? ` WHERE DocNumber = '${exampleDocNumber.replace(/'/g, "''")}'`
        : ""
      const json = (await qboQuery(
        `SELECT * FROM PurchaseOrder${where} MAXRESULTS 1`
      )) as { QueryResponse?: { PurchaseOrder?: unknown[] } }
      return json?.QueryResponse?.PurchaseOrder?.[0] ?? null
    },
    null
  )

  return { company, vendors, accounts, items, examplePurchaseOrder, errors }
}
