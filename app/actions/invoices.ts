"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { qboQuery } from "@/lib/quickbooks/client"
import { getQboConnection } from "@/lib/quickbooks/storage"
import {
  syncProjectInvoicesFromQbo,
  type InvoiceSyncResult,
} from "@/lib/quickbooks/invoices"

/**
 * Staff-side actions for the client-invoice hybrid: link a project to its QBO
 * Customer, backfill/refresh the qbo_invoices cache, unlink. The Invoices tab
 * itself reads qbo_invoices straight through RLS (server component) — no
 * action needed for display.
 */

export type QboCustomerHit = { id: string; name: string }

const searchSchema = z.string().trim().min(2).max(80)

/** Live QBO Customer search for the link-customer picker. */
export async function searchQboCustomers(
  query: string
): Promise<{ ok: true; customers: QboCustomerHit[] } | { ok: false; error: string }> {
  await requireStaff()
  const parsed = searchSchema.safeParse(query)
  if (!parsed.success) return { ok: false, error: "Type at least 2 characters." }
  const conn = await getQboConnection()
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }

  // % and _ are LIKE wildcards with no documented escape — strip them, then
  // backslash-escape quote characters (QBO's convention).
  const term = parsed.data
    .replace(/[%_]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
  try {
    const json = (await qboQuery(
      `SELECT Id, DisplayName, FullyQualifiedName FROM Customer WHERE Active = true AND DisplayName LIKE '%${term}%' MAXRESULTS 20`
    )) as {
      QueryResponse?: {
        Customer?: Array<{
          Id?: string
          DisplayName?: string
          FullyQualifiedName?: string
        }>
      }
    }
    const customers = (json?.QueryResponse?.Customer ?? [])
      .filter((c) => c.Id)
      .map((c) => ({
        id: c.Id as string,
        // FullyQualifiedName includes the parent path ("Smith:Lot 12") — the
        // clearer label when jobs are sub-customers.
        name: c.FullyQualifiedName || c.DisplayName || (c.Id as string),
      }))
    return { ok: true, customers }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const linkSchema = z.object({
  project_id: z.string().uuid(),
  customer_id: z.string().trim().min(1),
  customer_name: z.string().trim().min(1).max(200),
})

/** Link a project to a QBO Customer and backfill its invoices. */
export async function linkProjectQboCustomer(input: {
  project_id: string
  customer_id: string
  customer_name: string
}): Promise<InvoiceSyncResult> {
  await requireStaff()
  const parsed = linkSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid customer selection." }
  const { project_id, customer_id, customer_name } = parsed.data

  // The projects update runs under the caller's session so RLS still gates it.
  const supabase = await createSupabaseServerClient()
  const { data: updated, error } = await supabase
    .from("projects")
    .update({ qbo_customer_id: customer_id, qbo_customer_name: customer_name })
    .eq("id", project_id)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!updated) return { ok: false, error: "Project not found." }

  // Re-linking to a different customer: purge the old customer's cached rows
  // so the client never sees another job's invoices while the backfill runs.
  const admin = createSupabaseAdminClient()
  if (admin) {
    await admin
      .from("qbo_invoices")
      .delete()
      .eq("project_id", project_id)
  }

  const result = await syncProjectInvoicesFromQbo({
    id: project_id,
    qbo_customer_id: customer_id,
  })
  revalidatePath(`/projects/${project_id}/invoices`)
  return result
}

const projectIdSchema = z.object({ project_id: z.string().uuid() })

/** Unlink the QBO Customer and drop the project's cached invoices. */
export async function unlinkProjectQboCustomer(input: {
  project_id: string
}): Promise<{ ok: boolean; error?: string }> {
  await requireStaff()
  const parsed = projectIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid project." }
  const { project_id } = parsed.data

  const supabase = await createSupabaseServerClient()
  const { data: updated, error } = await supabase
    .from("projects")
    .update({ qbo_customer_id: null, qbo_customer_name: null })
    .eq("id", project_id)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!updated) return { ok: false, error: "Project not found." }

  // Hard delete, not tombstone — an unlink usually means "wrong customer",
  // and wrong-customer invoices must not linger anywhere a client can look.
  const admin = createSupabaseAdminClient()
  if (admin) {
    const { error: delErr } = await admin
      .from("qbo_invoices")
      .delete()
      .eq("project_id", project_id)
    if (delErr) return { ok: false, error: delErr.message }
  }

  revalidatePath(`/projects/${project_id}/invoices`)
  return { ok: true }
}

// Who gets the in-app "payment received" notification. Stored as a JSON array
// of profile ids in app_settings (same pattern as qbo_push_defaults). A
// missing key falls back to staff with financial_access; an explicitly saved
// empty list means notify nobody.
const RECIPIENTS_KEY = "invoice_payment_recipients"

const recipientIdsSchema = z.array(z.string().uuid()).max(50)

export type PaymentRecipientConfig = {
  staff: { id: string; full_name: string }[]
  selected: string[]
}

/** Staff picklist + current payment-notification recipients (settings UI). */
export async function getInvoicePaymentRecipientConfig(): Promise<PaymentRecipientConfig> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const [{ data: staff }, { data: setting }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, financial_access")
      .eq("role", "staff")
      .order("full_name"),
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", RECIPIENTS_KEY)
      .maybeSingle(),
  ])

  const staffRows = staff ?? []
  let selected: string[] | null = null
  if (setting?.value != null) {
    try {
      const parsed = recipientIdsSchema.safeParse(JSON.parse(setting.value))
      if (parsed.success) selected = parsed.data
    } catch {
      // Unparseable value — treat as unset and show the fallback below.
    }
  }
  return {
    staff: staffRows.map((p) => ({ id: p.id, full_name: p.full_name })),
    // Never-configured: pre-check the effective fallback (financial_access
    // staff) so the UI shows who actually gets notified today.
    selected:
      selected ?? staffRows.filter((p) => p.financial_access).map((p) => p.id),
  }
}

/** Save the payment-notification recipient list (staff only). */
export async function saveInvoicePaymentRecipients(
  ids: string[]
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireStaff()
  const parsed = recipientIdsSchema.safeParse(ids)
  if (!parsed.success) return { ok: false, error: "Invalid recipient list." }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: RECIPIENTS_KEY,
      value: JSON.stringify(parsed.data),
      updated_by: profile.id,
    },
    { onConflict: "key" }
  )
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings/quickbooks")
  return { ok: true }
}

/** Manual "Sync now" — full reconcile against the linked customer. */
export async function syncProjectInvoices(input: {
  project_id: string
}): Promise<InvoiceSyncResult> {
  await requireStaff()
  const parsed = projectIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid project." }
  const { project_id } = parsed.data

  const supabase = await createSupabaseServerClient()
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, qbo_customer_id")
    .eq("id", project_id)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!project) return { ok: false, error: "Project not found." }
  if (!project.qbo_customer_id) {
    return { ok: false, error: "Link a QuickBooks customer first." }
  }

  const result = await syncProjectInvoicesFromQbo({
    id: project.id,
    qbo_customer_id: project.qbo_customer_id,
  })
  revalidatePath(`/projects/${project_id}/invoices`)
  return result
}
