"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId } from "@/lib/org"
import {
  getQboConnection,
  getQboStatus,
  deleteQboConnection,
  getPoSync,
  getPoSyncMany,
  upsertPoSync,
  type QboConnectionStatus,
  type QboPoSync,
} from "@/lib/quickbooks/storage"
import { revokeToken } from "@/lib/quickbooks/oauth"
import {
  fetchDiagnosticSnapshot,
  listItems,
  listCustomers,
  listClasses,
  getApAccountId,
  findVendorIdByName,
  type QboOption,
} from "@/lib/quickbooks/client"
import {
  createPurchaseOrder,
  type PoInput,
  type PushDefaults,
} from "@/lib/quickbooks/purchase-orders"

const PUSH_DEFAULTS_KEY = "qbo_push_defaults"

/** Redacted connection status for the settings page (active org's). */
export async function qboStatusAction(): Promise<QboConnectionStatus | null> {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)
  return getQboStatus(orgId)
}

/** Disconnect: revoke the refresh token at Intuit, then drop the stored row. */
export async function disconnectQboAction(): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)
  const conn = await getQboConnection(orgId)
  if (!conn) return { ok: true }
  await revokeToken(conn.refresh_token)
  const deleted = await deleteQboConnection(conn.realm_id)
  revalidatePath("/settings/quickbooks")
  return deleted ? { ok: true } : { ok: false, error: "Could not remove the stored connection." }
}

export type QboDiagnosticResult =
  | { ok: true; snapshot: Awaited<ReturnType<typeof fetchDiagnosticSnapshot>> }
  | { ok: false; error: string }

/**
 * Read-only connection check: pulls the company profile plus a sample of
 * vendors, accounts, items, and one example PurchaseOrder so we can see exactly
 * how the connected file structures a PO before building the push (Phase 2).
 * `exampleDocNumber` targets a specific PO (e.g. the manually-created "1001").
 */
// DocNumber is capped at 21 chars by QBO; validate the free-text input before
// it reaches the query builder.
const diagnosticInputSchema = z.string().trim().max(21).optional()

export async function runQboDiagnosticAction(
  exampleDocNumber?: string
): Promise<QboDiagnosticResult> {
  const profile = await requireStaff()
  const parsed = diagnosticInputSchema.safeParse(exampleDocNumber)
  if (!parsed.success) return { ok: false, error: "Invalid document number." }
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)
  const conn = await getQboConnection(orgId)
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }
  try {
    const snapshot = await fetchDiagnosticSnapshot(orgId, parsed.data || undefined)
    return { ok: true, snapshot }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — pushing Purchase Orders into QuickBooks
// ---------------------------------------------------------------------------

const pushDefaultsSchema = z.object({
  item_id: z.string().trim().min(1, "Choose a default Item"),
  customer_id: z.string().trim().nullable().optional(),
  class_id: z.string().trim().nullable().optional(),
})

/** The org-wide push defaults (default Item / Customer / Class), or null. */
export async function getQboPushDefaults(): Promise<PushDefaults | null> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", PUSH_DEFAULTS_KEY)
    .maybeSingle()
  if (!data?.value) return null
  try {
    const parsed = pushDefaultsSchema.safeParse(JSON.parse(data.value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Save the push defaults (staff only). */
export async function saveQboPushDefaults(
  input: PushDefaults
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireStaff()
  const parsed = pushDefaultsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid defaults." }
  }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("app_settings").upsert(
    {
      org_id: await getActiveOrgId(supabase),
      key: PUSH_DEFAULTS_KEY,
      value: JSON.stringify(parsed.data),
      updated_by: profile.id,
    },
    { onConflict: "org_id,key" }
  )
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings/quickbooks")
  return { ok: true }
}

export type QboLists = { items: QboOption[]; customers: QboOption[]; classes: QboOption[] }

/** Live Item / Customer / Class picklists for the push-defaults dropdowns. */
export async function getQboLists(): Promise<
  { ok: true; lists: QboLists } | { ok: false; error: string }
> {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)
  const conn = await getQboConnection(orgId)
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }
  try {
    const [items, customers, classes] = await Promise.all([
      listItems(orgId),
      listCustomers(orgId),
      listClasses(orgId),
    ])
    return { ok: true, lists: { items, customers, classes } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Sync records for a set of purchase orders (drawer / list status badges). */
export async function getQboPoSyncStatus(
  purchaseOrderIds: string[]
): Promise<Record<string, QboPoSync>> {
  await requireStaff()
  return getPoSyncMany(purchaseOrderIds)
}

export type PushPoResult =
  | { ok: true; qbo_po_id: string; doc_number: string; already_existed: boolean }
  | { ok: false; error: string }

/**
 * Push one approved PO into QuickBooks (idempotent). Resolves the vendor by
 * name, uses the configured push defaults for the line Item/Customer/Class, and
 * records the result in qbo_po_sync.
 */
export async function pushPurchaseOrderToQbo(input: {
  id: string
  project_id: string
}): Promise<PushPoResult> {
  await requireStaff()
  // The PO pushes through the connection of the org that OWNS it — the
  // project's org, never the caller's active org (a multi-org staffer could
  // have another org selected). The session-RLS read also proves the caller
  // can see the project at all.
  const orgSupabase = await createSupabaseServerClient()
  const { data: project, error: projErr } = await orgSupabase
    .from("projects")
    .select("org_id")
    .eq("id", input.project_id)
    .maybeSingle()
  if (projErr || !project) return { ok: false, error: "Project not found." }
  const orgId = project.org_id
  const conn = await getQboConnection(orgId)
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }

  const defaults = await getQboPushDefaults()
  if (!defaults || !defaults.item_id) {
    return { ok: false, error: "Set the default Item in QuickBooks settings before pushing." }
  }

  // Already synced? Return the stored id rather than re-hitting QBO.
  const existingSync = await getPoSync(input.id)
  if (existingSync?.status === "synced" && existingSync.qbo_po_id) {
    return {
      ok: true,
      qbo_po_id: existingSync.qbo_po_id,
      doc_number: existingSync.doc_number ?? "",
      already_existed: true,
    }
  }

  const supabase = await createSupabaseServerClient()
  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select(
      "id, project_id, number, custom_number, company_id, status, flat_fee, flat_total, title, scope, created_at"
    )
    .eq("id", input.id)
    .maybeSingle()
  if (poErr || !po) return { ok: false, error: "Purchase order not found." }
  if (po.project_id !== input.project_id) {
    return { ok: false, error: "Purchase order does not belong to that project." }
  }
  if (po.status !== "approved") {
    return { ok: false, error: "Only an approved purchase order can be pushed." }
  }

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", po.company_id)
    .maybeSingle()
  if (!company?.name) return { ok: false, error: "Vendor company not found." }

  const { data: lineRows, error: lineErr } = await supabase
    .from("po_line_items")
    .select("description, quantity, unit_cost, position")
    .eq("purchase_order_id", po.id)
    .order("position", { ascending: true })
  if (lineErr) return { ok: false, error: "Could not load the PO line items." }
  // A non-flat PO with no lines would serialize as a $0 order — refuse it
  // rather than pushing a meaningless PO into QuickBooks.
  if (!po.flat_fee && (lineRows ?? []).length === 0) {
    return { ok: false, error: "This purchase order has no line items to push." }
  }

  try {
    const vendorId = await findVendorIdByName(orgId, company.name)
    if (!vendorId) {
      return {
        ok: false,
        error: `No QuickBooks vendor named "${company.name}". Create it in QuickBooks (or rename to match), then retry.`,
      }
    }
    const apAccountId = await getApAccountId(orgId)
    if (!apAccountId) {
      return { ok: false, error: "No Accounts Payable account found in QuickBooks." }
    }

    const poInput: PoInput = {
      purchase_order_id: po.id,
      doc_number: po.custom_number?.trim() || String(po.number),
      vendor_id: vendorId,
      ap_account_id: apAccountId,
      private_note: po.title || po.scope || null,
      txn_date: po.created_at ? String(po.created_at).slice(0, 10) : null,
      flat_fee: po.flat_fee,
      flat_total: po.flat_total,
      lines: (lineRows ?? []).map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unit_cost: Number(l.unit_cost),
      })),
    }

    const result = await createPurchaseOrder(orgId, poInput, defaults)
    await upsertPoSync({
      purchase_order_id: po.id,
      qbo_realm_id: conn.realm_id,
      qbo_po_id: result.qbo_po_id,
      doc_number: result.doc_number,
      sync_token: result.sync_token,
      status: "synced",
      last_error: null,
      synced_at: new Date().toISOString(),
    })
    revalidatePath(`/projects/${input.project_id}/purchase-orders`)
    revalidatePath(`/projects/${input.project_id}/purchasing`)
    return {
      ok: true,
      qbo_po_id: result.qbo_po_id,
      doc_number: result.doc_number,
      already_existed: result.already_existed,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await upsertPoSync({
      purchase_order_id: po.id,
      qbo_realm_id: conn.realm_id,
      status: "error",
      last_error: msg,
    })
    revalidatePath(`/projects/${input.project_id}/purchase-orders`)
    revalidatePath(`/projects/${input.project_id}/purchasing`)
    return { ok: false, error: msg }
  }
}
