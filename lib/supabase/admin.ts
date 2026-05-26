import "server-only"
import { createClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

// Admin client backed by the service-role key. Bypasses RLS and unlocks the
// `auth.admin` API (createUser, deleteUser, generateLink). Only call from
// server actions / route handlers behind requireStaff() — never expose this to
// the client. Returns null if the env var is unset so callers can surface a
// clean error instead of crashing on undefined.
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
