import "server-only"
import { createClient } from "@supabase/supabase-js"
import type { QboEnvironment } from "./config"

/**
 * Persistence for the single QuickBooks Online OAuth connection (table
 * qbo_connection, migration 0085). The table has NO RLS policies — only the
 * service-role key can read/write it, because the refresh_token is a secret
 * that must never reach a browser session. We therefore use a dedicated
 * service-role client here (same shape as the specmagician/crm clients), NOT
 * the typed app admin client, since qbo_connection isn't in the generated
 * Database types until `supabase gen types` is re-run.
 */

export type QboConnection = {
  // Which org this connection belongs to (0099 stamped the column; v1 is a
  // single Hines row). Consumers that read org-scoped settings on behalf of
  // the webhook must filter by this — the admin client bypasses RLS.
  org_id: string
  realm_id: string
  environment: QboEnvironment
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  refresh_token_expires_at: string
  company_name: string | null
  connected_by: string | null
  created_at: string
  updated_at: string
}

/** Non-secret subset safe to surface to a staff UI. */
export type QboConnectionStatus = {
  realm_id: string
  environment: QboEnvironment
  company_name: string | null
  connected_at: string
  refresh_token_expires_at: string
}

function makeQboStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// Memoized so the several storage helpers that can run in one request (e.g.
// getValidAccessToken → getQboConnection → updateQboTokens) reuse one client
// instead of re-constructing it each call. `undefined` = not yet resolved.
let cachedStore: ReturnType<typeof makeQboStore> | undefined

/** The service-role client for qbo_connection, or null if env is unset. */
function qboStore() {
  if (cachedStore === undefined) cachedStore = makeQboStore()
  return cachedStore
}

/** The current connection (v1 stores a single row), or null if not connected. */
export async function getQboConnection(): Promise<QboConnection | null> {
  const store = qboStore()
  if (!store) return null
  const { data, error } = await store
    .from("qbo_connection")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[qbo] getQboConnection failed:", error.message)
    return null
  }
  return (data as QboConnection | null) ?? null
}

/** Redacted status for the settings UI, or null if not connected. */
export async function getQboStatus(): Promise<QboConnectionStatus | null> {
  const conn = await getQboConnection()
  if (!conn) return null
  return {
    realm_id: conn.realm_id,
    environment: conn.environment,
    company_name: conn.company_name,
    connected_at: conn.created_at,
    refresh_token_expires_at: conn.refresh_token_expires_at,
  }
}

/** Upsert the connection row (keyed by realm_id). */
export async function saveQboConnection(row: {
  realm_id: string
  environment: QboEnvironment
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  refresh_token_expires_at: string
  company_name?: string | null
  connected_by?: string | null
}): Promise<boolean> {
  const store = qboStore()
  if (!store) return false
  const { error } = await store
    .from("qbo_connection")
    .upsert(row, { onConflict: "realm_id" })
  if (error) {
    console.error("[qbo] saveQboConnection failed:", error.message)
    return false
  }
  return true
}

/**
 * Update just the tokens after a refresh. Intuit rotates the refresh token
 * periodically and invalidates the previous one, so the rotated refresh_token
 * from every refresh response MUST be persisted or the next refresh 400s with
 * invalid_grant.
 */
export async function updateQboTokens(
  realmId: string,
  tokens: {
    access_token: string
    refresh_token: string
    access_token_expires_at: string
    refresh_token_expires_at: string
  }
): Promise<boolean> {
  const store = qboStore()
  if (!store) return false
  const { error } = await store
    .from("qbo_connection")
    .update(tokens)
    .eq("realm_id", realmId)
  if (error) {
    console.error("[qbo] updateQboTokens failed:", error.message)
    return false
  }
  return true
}

export type QboPoSync = {
  purchase_order_id: string
  qbo_realm_id: string
  qbo_po_id: string | null
  doc_number: string | null
  sync_token: string | null
  status: string
  last_error: string | null
  synced_at: string | null
}

/** Sync record for one of our purchase orders, or null if never pushed. */
export async function getPoSync(purchaseOrderId: string): Promise<QboPoSync | null> {
  const store = qboStore()
  if (!store) return null
  const { data, error } = await store
    .from("qbo_po_sync")
    .select("*")
    .eq("purchase_order_id", purchaseOrderId)
    .maybeSingle()
  if (error) {
    console.error("[qbo] getPoSync failed:", error.message)
    return null
  }
  return (data as QboPoSync | null) ?? null
}

/** Sync records for several purchase orders (drawer/list status). */
export async function getPoSyncMany(
  purchaseOrderIds: string[]
): Promise<Record<string, QboPoSync>> {
  const store = qboStore()
  if (!store || purchaseOrderIds.length === 0) return {}
  const { data, error } = await store
    .from("qbo_po_sync")
    .select("*")
    .in("purchase_order_id", purchaseOrderIds)
  if (error) {
    console.error("[qbo] getPoSyncMany failed:", error.message)
    return {}
  }
  const out: Record<string, QboPoSync> = {}
  for (const row of (data ?? []) as QboPoSync[]) out[row.purchase_order_id] = row
  return out
}

/** Record (or update) the result of a push. */
export async function upsertPoSync(row: {
  purchase_order_id: string
  qbo_realm_id: string
  qbo_po_id?: string | null
  doc_number?: string | null
  sync_token?: string | null
  status: string
  last_error?: string | null
  synced_at?: string | null
}): Promise<void> {
  const store = qboStore()
  if (!store) return
  const { error } = await store
    .from("qbo_po_sync")
    .upsert({ ...row, updated_at: new Date().toISOString() }, {
      onConflict: "purchase_order_id",
    })
  if (error) console.error("[qbo] upsertPoSync failed:", error.message)
}

/** Remove the connection (on disconnect). */
export async function deleteQboConnection(realmId: string): Promise<boolean> {
  const store = qboStore()
  if (!store) return false
  const { error } = await store
    .from("qbo_connection")
    .delete()
    .eq("realm_id", realmId)
  if (error) {
    console.error("[qbo] deleteQboConnection failed:", error.message)
    return false
  }
  return true
}
