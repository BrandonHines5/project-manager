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

/** A non-2xx response from the QBO API, carrying the status, body, and tid. */
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

/** Thrown when an API call is attempted with no stored QBO connection. */
export class QboNotConnectedError extends Error {
  constructor() {
    super("QuickBooks is not connected")
    this.name = "QboNotConnectedError"
  }
}

/** Authenticated request to `/v3/company/{realm}/{path}`, retrying once on 401. */
async function qboRequest(
  orgId: string,
  path: string,
  init: RequestInit,
  attempt = 0
): Promise<unknown> {
  const auth = await getValidAccessToken(orgId, attempt > 0)
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
    return qboRequest(orgId, path, init, 1)
  }
  const text = await res.text().catch(() => "")
  const intuitTid = res.headers.get("intuit_tid")
  if (!res.ok) {
    console.error(`[qbo] request failed (${res.status}, tid=${intuitTid ?? "?"}): ${text.slice(0, 300)}`)
    throw new QboApiError(res.status, text, intuitTid)
  }
  return text ? JSON.parse(text) : null
}

/** GET a QBO entity/query path (against the org's connected realm). */
export function qboGet(orgId: string, path: string): Promise<unknown> {
  return qboRequest(orgId, path, { method: "GET" })
}

/** Run a QBO SQL-like query (SELECT ... FROM Entity WHERE ...). */
export function qboQuery(orgId: string, query: string): Promise<unknown> {
  return qboGet(orgId, `query?query=${encodeURIComponent(query)}`)
}

/** POST a body to a QBO entity path (create/update). */
export function qboPost(orgId: string, path: string, body: unknown): Promise<unknown> {
  return qboRequest(orgId, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** A picklist entry (id + label) for the push-defaults dropdowns. */
export type QboOption = { id: string; name: string }

type QboNamedRow = {
  Id?: string
  Name?: string
  DisplayName?: string
  FullyQualifiedName?: string
}

// QBO returns query rows under a key equal to the entity name
// (QueryResponse.Item / .Customer / .Class). Pages via STARTPOSITION/MAXRESULTS
// so a company with >1000 active rows isn't silently truncated.
async function queryOptions(orgId: string, entity: string): Promise<QboOption[]> {
  const out: QboOption[] = []
  const pageSize = 1000
  const maxPages = 20 // 20k active rows is far beyond any real picklist
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize + 1
    const json = (await qboQuery(
      orgId,
      `SELECT * FROM ${entity} WHERE Active = true STARTPOSITION ${start} MAXRESULTS ${pageSize}`
    )) as { QueryResponse?: Record<string, QboNamedRow[]> }
    const rows = json?.QueryResponse?.[entity] ?? []
    for (const r of rows) {
      if (r.Id) {
        out.push({
          id: r.Id,
          name: r.FullyQualifiedName || r.DisplayName || r.Name || r.Id,
        })
      }
    }
    if (rows.length < pageSize) break
  }
  return out
}

/** Active Items (Products/Services) — the cost-code analog for PO lines. */
export function listItems(orgId: string): Promise<QboOption[]> {
  return queryOptions(orgId, "Item")
}

/** Active Customers (jobs) for the default CustomerRef. */
export function listCustomers(orgId: string): Promise<QboOption[]> {
  return queryOptions(orgId, "Customer")
}

/** Active Classes for the default ClassRef. */
export function listClasses(orgId: string): Promise<QboOption[]> {
  return queryOptions(orgId, "Class")
}

/** The Accounts Payable account id (target of a PO's APAccountRef). */
export async function getApAccountId(orgId: string): Promise<string | null> {
  const json = (await qboQuery(
    orgId,
    "SELECT * FROM Account WHERE AccountType = 'Accounts Payable' MAXRESULTS 1"
  )) as { QueryResponse?: { Account?: Array<{ Id?: string }> } }
  return json?.QueryResponse?.Account?.[0]?.Id ?? null
}

/** Resolve a QBO Vendor id by exact DisplayName (case-insensitive). */
export async function findVendorIdByName(orgId: string, name: string): Promise<string | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const json = (await qboQuery(
    orgId,
    `SELECT * FROM Vendor WHERE DisplayName = '${escaped}'`
  )) as { QueryResponse?: { Vendor?: Array<{ Id?: string }> } }
  return json?.QueryResponse?.Vendor?.[0]?.Id ?? null
}

/** Look up an existing PurchaseOrder by DocNumber (idempotency check). */
export async function findPurchaseOrderByDocNumber(
  orgId: string,
  docNumber: string
): Promise<{ Id: string; SyncToken: string } | null> {
  const escaped = docNumber.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const json = (await qboQuery(
    orgId,
    `SELECT * FROM PurchaseOrder WHERE DocNumber = '${escaped}' MAXRESULTS 1`
  )) as { QueryResponse?: { PurchaseOrder?: Array<{ Id?: string; SyncToken?: string }> } }
  const po = json?.QueryResponse?.PurchaseOrder?.[0]
  return po?.Id ? { Id: po.Id, SyncToken: po.SyncToken ?? "0" } : null
}

export type QboRef = { value?: string; name?: string }

export type QboCompanyInfo = {
  CompanyName?: string
  LegalName?: string
  Country?: string
}

/** The connected company's profile (name shown in the settings UI). */
export async function getCompanyInfo(orgId: string): Promise<QboCompanyInfo | null> {
  const json = (await qboQuery(orgId, "SELECT * FROM CompanyInfo")) as {
    QueryResponse?: { CompanyInfo?: QboCompanyInfo[] }
  }
  return json?.QueryResponse?.CompanyInfo?.[0] ?? null
}

/**
 * Fetch reference data + an example PurchaseOrder for the connection
 * diagnostic. Every field is optional; a failing sub-query is reported rather
 * than aborting the whole diagnostic.
 */
export async function fetchDiagnosticSnapshot(
  orgId: string,
  exampleDocNumber?: string
): Promise<{
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

  const company = await safe("company", () => getCompanyInfo(orgId), null)
  const vendors = await safe(
    "vendors",
    async () =>
      ((await qboQuery(orgId, "SELECT * FROM Vendor WHERE Active = true MAXRESULTS 10")) as {
        QueryResponse?: { Vendor?: unknown[] }
      })?.QueryResponse?.Vendor ?? [],
    [] as unknown[]
  )
  const accounts = await safe(
    "accounts",
    async () =>
      ((await qboQuery(
        orgId,
        "SELECT * FROM Account WHERE AccountType IN ('Expense','Cost of Goods Sold','Accounts Payable') MAXRESULTS 20"
      )) as { QueryResponse?: { Account?: unknown[] } })?.QueryResponse?.Account ?? [],
    [] as unknown[]
  )
  const items = await safe(
    "items",
    async () =>
      ((await qboQuery(orgId, "SELECT * FROM Item MAXRESULTS 20")) as {
        QueryResponse?: { Item?: unknown[] }
      })?.QueryResponse?.Item ?? [],
    [] as unknown[]
  )
  const examplePurchaseOrder = await safe(
    "purchaseOrder",
    async () => {
      // QBO query literals escape with a backslash (\' ), NOT SQL-style
      // doubling ('') — escape backslashes first, then apostrophes.
      const where = exampleDocNumber
        ? ` WHERE DocNumber = '${exampleDocNumber.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
        : ""
      const json = (await qboQuery(
        orgId,
        `SELECT * FROM PurchaseOrder${where} MAXRESULTS 1`
      )) as { QueryResponse?: { PurchaseOrder?: unknown[] } }
      return json?.QueryResponse?.PurchaseOrder?.[0] ?? null
    },
    null
  )

  return { company, vendors, accounts, items, examplePurchaseOrder, errors }
}
