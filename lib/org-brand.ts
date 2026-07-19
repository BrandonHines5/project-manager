import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import {
  DEFAULT_BRAND_CONFIG,
  parseBrandConfig,
  type BrandConfig,
} from "@/lib/brand"

/**
 * An org's BrandConfig from `organizations.settings.brands` (Stage B3).
 * Works with either the session client (layouts/pages — orgs_member_read
 * covers the caller's own org) or the admin client (token pages, actions
 * that already run privileged). A missing org id or unreadable row falls
 * back to the historical static Hines/MJV config so nothing user-visible
 * changes if a lookup hiccups; an org row WITHOUT a brands block gets the
 * neutral app default carrying the org's name (see parseBrandConfig).
 */
export async function getBrandConfig(
  client: SupabaseClient<Database>,
  orgId: string | null | undefined
): Promise<BrandConfig> {
  if (!orgId) return DEFAULT_BRAND_CONFIG
  const { data, error } = await client
    .from("organizations")
    .select("name, settings")
    .eq("id", orgId)
    .maybeSingle()
  if (error || !data) return DEFAULT_BRAND_CONFIG
  return parseBrandConfig(data.settings, data.name)
}
