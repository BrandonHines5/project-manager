"use server"

import { revalidatePath } from "next/cache"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import { isLegacyActiveOrg } from "@/lib/org"
import { crmStatusToEnum } from "@/lib/crm-status"
import type { Enums, TablesUpdate } from "@/lib/db/types"

// Raw shape read from the CRM `projects` table (an untyped client, so we narrow
// it ourselves). `qb_job_name` is Hines' official short job name
// ("303 Devoe - WL - Chirpich"); the address fields are the fallback name.
type CrmProjectRow = {
  project_number: string | null
  project_status: string | null
  qb_job_name: string | null
  buildertrend_job_name: string | null
  street_address: string | null
  // FKs into the CRM `clients` table for the (up to two) clients on a job.
  // Resolved to name/email/phone in a follow-up batched read.
  client_id: string | null
  client_id_2: string | null
}

// A CRM `clients` row — the source of truth for a client's contact info. The
// CRM keeps each person (both spouses of a couple) as their own row.
type CrmClientRow = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}

// Local project we might sync — only the columns the sync reads/writes.
type LocalProject = {
  id: string
  project_number: string
  name: string
  status: Enums<"project_status">
  crm_status: string | null
  is_template: boolean
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  client_name_2: string | null
  client_email_2: string | null
  client_phone_2: string | null
}

export type SyncFromCrmResult =
  | {
      ok: true
      matched: number
      statusChanged: number
      nameChanged: number
      contactsChanged: number
      unmatched: string[]
    }
  | { ok: false; error: string }

/**
 * The Hines Homes CRM's official short job name, with a sensible fallback chain
 * so every matched project gets *some* canonical name. Returns null only when
 * the CRM row has no usable name field at all (then we leave the local name
 * untouched).
 */
function canonicalCrmName(row: CrmProjectRow): string | null {
  return (
    row.qb_job_name?.trim() ||
    row.buildertrend_job_name?.trim() ||
    row.street_address?.trim() ||
    null
  )
}

/**
 * Pulls each local project's status + official name from the Hines Homes CRM so
 * the job list mirrors the CRM. Matched by `project_number` (the shared key
 * between the two systems). Staff-only, re-runnable, idempotent.
 *
 * For every matched project we store the CRM's `project_status` verbatim in
 * `crm_status` (what the badge shows), map it back onto PM's `status` enum
 * (what the Open/Active/Warranty/Closed filter + warranty page run off), set
 * `name` to the CRM's official short name, and pull each client's contact info
 * (name/email/phone for both client slots) from the CRM `clients` table so the
 * Clients directory + portal invites have real contacts. Contact fields are
 * filled only when the CRM has a value — a sync never blanks out what PM has.
 * Templates are skipped; project numbers with no CRM row are returned as
 * `unmatched` for transparency.
 *
 * Returns a typed result rather than throwing — Next masks thrown messages in
 * production, and "CRM not configured" needs to reach the user verbatim.
 */
export async function syncProjectsFromCrm(): Promise<SyncFromCrmResult> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()

  // The CRM is Hines' own external database (global env creds). Only the legacy
  // (Hines) org may sync from it — never pull Hines' project list into another
  // tenant.
  if (!(await isLegacyActiveOrg(supabase, me.id))) {
    return {
      ok: false,
      error: "Sync from CRM is only available for Hines Homes.",
    }
  }

  const crm = createCrmClient()
  if (!crm) {
    return {
      ok: false,
      error:
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  const { data: localRows, error: localErr } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, status, crm_status, is_template, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2"
    )
  if (localErr) return { ok: false, error: localErr.message }

  // Only real jobs sync — templates (and the "TEMPLATE-*" naming convention)
  // never have a CRM counterpart, so they'd only add noise to `unmatched`.
  const locals = ((localRows ?? []) as LocalProject[]).filter(
    (p) =>
      !p.is_template &&
      !p.project_number.toUpperCase().startsWith("TEMPLATE")
  )
  if (locals.length === 0) {
    return {
      ok: true,
      matched: 0,
      statusChanged: 0,
      nameChanged: 0,
      contactsChanged: 0,
      unmatched: [],
    }
  }

  const numbers = locals.map((p) => p.project_number)
  const { data: crmRows, error: crmErr } = await crm
    .from("projects")
    .select(
      "project_number, project_status, qb_job_name, buildertrend_job_name, street_address, client_id, client_id_2"
    )
    .in("project_number", numbers)
  if (crmErr) return { ok: false, error: crmErr.message }

  const crmByNumber = new Map<string, CrmProjectRow>()
  for (const r of (crmRows ?? []) as CrmProjectRow[]) {
    if (r.project_number) crmByNumber.set(r.project_number, r)
  }

  // Resolve the client FKs to contact rows in one batched read.
  const clientIds = Array.from(
    new Set(
      (crmRows ?? [])
        .flatMap((r) => [
          (r as CrmProjectRow).client_id,
          (r as CrmProjectRow).client_id_2,
        ])
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  )
  const clientById = new Map<string, CrmClientRow>()
  if (clientIds.length > 0) {
    const { data: clientRows, error: clientErr } = await crm
      .from("clients")
      .select("id, name, email, phone")
      .in("id", clientIds)
    if (clientErr) return { ok: false, error: clientErr.message }
    for (const c of (clientRows ?? []) as CrmClientRow[]) clientById.set(c.id, c)
  }

  const nowIso = new Date().toISOString()
  const unmatched: string[] = []
  let statusChanged = 0
  let nameChanged = 0
  let contactsChanged = 0

  const updates: Array<{ id: string; patch: TablesUpdate<"projects"> }> = []
  for (const p of locals) {
    const crmRow = crmByNumber.get(p.project_number)
    if (!crmRow) {
      unmatched.push(p.project_number)
      continue
    }

    const crmStatus = crmRow.project_status?.trim() || null
    const patch: TablesUpdate<"projects"> = {
      crm_status: crmStatus,
      crm_status_synced_at: nowIso,
    }

    // Keep the enum aligned so the sidebar filter / warranty page stay correct.
    const mapped = crmStatusToEnum(crmStatus)
    if (mapped && mapped !== p.status) {
      patch.status = mapped
      statusChanged += 1
    }

    // Adopt the CRM's official short name when we have one and it differs.
    const canonical = canonicalCrmName(crmRow)
    if (canonical && canonical !== p.name) {
      patch.name = canonical
      nameChanged += 1
    }

    // Pull each client's contact info from the CRM `clients` rows, mirroring
    // the CRM's structure (slot 1 = first client, slot 2 = second — a couple is
    // two rows there). Only fill a field when the CRM has a value; a sync never
    // blanks out PM data.
    const c1 = crmRow.client_id ? clientById.get(crmRow.client_id) : undefined
    const c2 = crmRow.client_id_2 ? clientById.get(crmRow.client_id_2) : undefined
    const beforeKeys = Object.keys(patch).length
    const c1name = c1?.name?.trim()
    const c1email = c1?.email?.trim()
    const c1phone = c1?.phone?.trim()
    const c2name = c2?.name?.trim()
    const c2email = c2?.email?.trim()
    const c2phone = c2?.phone?.trim()
    if (c1name && c1name !== (p.client_name ?? "")) patch.client_name = c1name
    if (c1email && c1email !== (p.client_email ?? "")) patch.client_email = c1email
    if (c1phone && c1phone !== (p.client_phone ?? "")) patch.client_phone = c1phone
    if (c2name && c2name !== (p.client_name_2 ?? "")) patch.client_name_2 = c2name
    if (c2email && c2email !== (p.client_email_2 ?? ""))
      patch.client_email_2 = c2email
    if (c2phone && c2phone !== (p.client_phone_2 ?? ""))
      patch.client_phone_2 = c2phone
    if (Object.keys(patch).length > beforeKeys) contactsChanged += 1

    updates.push({ id: p.id, patch })
  }

  // Apply concurrently — a few dozen single-row updates, each RLS-gated by the
  // caller's staff session. The updates are independent and the whole action is
  // idempotent (re-running re-applies cleanly), so we let them all settle and
  // report how many failed rather than masking partial progress behind the
  // first error. No transaction here — a failed run is safe to just re-run.
  const settled = await Promise.allSettled(
    updates.map(({ id, patch }) =>
      supabase.from("projects").update(patch).eq("id", id)
    )
  )
  const failures = settled.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && !!r.value.error)
  )
  if (failures.length > 0) {
    // Some updates may have landed before others failed — refresh so the
    // successful rows show up, then surface the partial failure.
    if (failures.length < updates.length) revalidatePath("/projects")
    const first = failures[0]
    const detail =
      first.status === "rejected"
        ? String(first.reason)
        : first.value.error?.message ?? "unknown error"
    return {
      ok: false,
      error: `${failures.length} of ${updates.length} project update${
        updates.length === 1 ? "" : "s"
      } failed (re-run Sync to retry): ${detail}`,
    }
  }

  revalidatePath("/projects")

  return {
    ok: true,
    matched: updates.length,
    statusChanged,
    nameChanged,
    contactsChanged,
    unmatched,
  }
}
