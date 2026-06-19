import "server-only"
import { createClient } from "@supabase/supabase-js"

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
