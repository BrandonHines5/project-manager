import "server-only"
import { createClient } from "@supabase/supabase-js"

// Direct read access to the HH-SpecMagician database (a separate Supabase
// project) — the item catalog used to price decision line items. Server-only:
// backed by the SpecMagician service-role key, so only call from server
// actions behind requireStaff(); never expose to the browser. Returns null if
// the env vars are unset so callers can degrade gracefully (catalog search
// reports "not connected") instead of crashing.
//
// Configure in Vercel (and .env.local for dev):
//   SPECMAGICIAN_SUPABASE_URL              = the SpecMagician project URL
//   SPECMAGICIAN_SUPABASE_SERVICE_ROLE_KEY = its service-role key (server-only)
export function createSpecMagicianClient() {
  const url = process.env.SPECMAGICIAN_SUPABASE_URL
  const serviceKey = process.env.SPECMAGICIAN_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
