import "server-only"
import { createClient } from "@supabase/supabase-js"
import { crmStatusToEnum } from "@/lib/crm-status"
import type { Enums } from "@/lib/db/types"

// Direct read access to the Hines Homes CRM database (a separate Supabase
// project). Server-only — backed by the CRM service-role key, so it can read
// any table directly instead of standing up a per-column API. Only call from
// server actions / route handlers behind requireStaff(); never expose to the
// browser. Returns null if the env vars are unset so callers can fall back to
// the local cache instead of crashing.
//
// Configure in Vercel (and .env.local for dev):
//   CRM_SUPABASE_URL                 = the CRM project URL
//   CRM_SUPABASE_SERVICE_ROLE_KEY    = the CRM service-role key (server-only)
export function createCrmClient() {
  const url = process.env.CRM_SUPABASE_URL
  const serviceKey = process.env.CRM_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export type CrmProjectStatus = {
  /** The CRM's verbatim status word (e.g. "Upcoming"), trimmed. Null when the
   *  CRM row's status is blank. */
  crmStatus: string | null
  /** The CRM status mapped onto PM's project_status enum, or null when it isn't
   *  a status we recognise (caller should keep its own default). */
  mapped: Enums<"project_status"> | null
}

/**
 * Look up one CRM project's status by project_number so a newly-created job can
 * mirror the CRM ("the dashboard") from birth instead of defaulting to "In
 * Work" until the next Sync from CRM. Returns null when the CRM isn't
 * configured or has no matching row, so callers fall back to the form value.
 * Server-only; call behind requireStaff() (same trust boundary as the sync).
 */
export async function getCrmProjectStatus(
  projectNumber: string
): Promise<CrmProjectStatus | null> {
  const crm = createCrmClient()
  if (!crm) return null
  const { data, error } = await crm
    .from("projects")
    .select("project_status")
    .eq("project_number", projectNumber)
    .maybeSingle()
  if (error || !data) return null
  const crmStatus =
    (data as { project_status: string | null }).project_status?.trim() || null
  return { crmStatus, mapped: crmStatusToEnum(crmStatus) }
}
