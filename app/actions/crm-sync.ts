"use server"

import { revalidatePath } from "next/cache"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
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
}

// Local project we might sync — only the columns the sync reads/writes.
type LocalProject = {
  id: string
  project_number: string
  name: string
  status: Enums<"project_status">
  crm_status: string | null
  is_template: boolean
}

export type SyncFromCrmResult =
  | {
      ok: true
      matched: number
      statusChanged: number
      nameChanged: number
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
 * (what the Open/Active/Warranty/Closed filter + warranty page run off), and
 * set `name` to the CRM's official short name. Templates are skipped; project
 * numbers with no CRM row are returned as `unmatched` for transparency.
 *
 * Returns a typed result rather than throwing — Next masks thrown messages in
 * production, and "CRM not configured" needs to reach the user verbatim.
 */
export async function syncProjectsFromCrm(): Promise<SyncFromCrmResult> {
  await requireStaff()

  const crm = createCrmClient()
  if (!crm) {
    return {
      ok: false,
      error:
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  const supabase = await createSupabaseServerClient()
  const { data: localRows, error: localErr } = await supabase
    .from("projects")
    .select("id, project_number, name, status, crm_status, is_template")
  if (localErr) return { ok: false, error: localErr.message }

  // Only real jobs sync — templates (and the "TEMPLATE-*" naming convention)
  // never have a CRM counterpart, so they'd only add noise to `unmatched`.
  const locals = ((localRows ?? []) as LocalProject[]).filter(
    (p) =>
      !p.is_template &&
      !p.project_number.toUpperCase().startsWith("TEMPLATE")
  )
  if (locals.length === 0) {
    return { ok: true, matched: 0, statusChanged: 0, nameChanged: 0, unmatched: [] }
  }

  const numbers = locals.map((p) => p.project_number)
  const { data: crmRows, error: crmErr } = await crm
    .from("projects")
    .select(
      "project_number, project_status, qb_job_name, buildertrend_job_name, street_address"
    )
    .in("project_number", numbers)
  if (crmErr) return { ok: false, error: crmErr.message }

  const crmByNumber = new Map<string, CrmProjectRow>()
  for (const r of (crmRows ?? []) as CrmProjectRow[]) {
    if (r.project_number) crmByNumber.set(r.project_number, r)
  }

  const nowIso = new Date().toISOString()
  const unmatched: string[] = []
  let statusChanged = 0
  let nameChanged = 0

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
    unmatched,
  }
}
