"use server"

import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSpecMagicianClient } from "@/lib/supabase/specmagician"

// Live search against the HH-SpecMagician item catalog (a separate Supabase
// project — see lib/supabase/specmagician.ts). Used by the decision cost-item
// editor's "link to catalog" picker. Read-only; the local link is stored on
// decision_cost_items.catalog_item_id/_code by saveDecision.

export type CatalogItemHit = {
  id: string
  code: string
  description: string
  category: string | null
  vendor: string | null
  unit: string | null
  // Cents in SpecMagician; the picker converts to dollars for unit_cost.
  unit_cost_cents: number | null
  suggested_price_cents: number | null
}

export type SearchCatalogResult =
  | { ok: true; items: CatalogItemHit[] }
  | { ok: false; error: string }

// Narrow local row type for the untyped cross-project client (same convention
// as the CRM callers — schema drift fails at runtime, never at compile time).
type CatalogRow = {
  id: string
  code: string
  description: string
  category: string | null
  vendor: string | null
  unit: string | null
  unit_cost_cents: number | null
  suggested_price_cents: number | null
}

export async function searchCatalogItems(input: {
  query: string
}): Promise<SearchCatalogResult> {
  await requireStaff()
  const parsed = z.object({ query: z.string().max(200) }).safeParse(input)
  if (!parsed.success) return { ok: false, error: "Bad search input." }
  const q = parsed.data.query.trim()
  if (q.length < 2) return { ok: true, items: [] }

  const sm = createSpecMagicianClient()
  if (!sm) {
    return {
      ok: false,
      error:
        "SpecMagician connection not configured. Set SPECMAGICIAN_SUPABASE_URL and SPECMAGICIAN_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  // Escape PostgREST or-filter specials so a search string can't break the
  // filter expression.
  const like = `%${q.replace(/[%_,()]/g, " ").trim()}%`
  try {
    const { data, error } = await sm
      .from("catalog_items")
      .select(
        "id, code, description, category, vendor, unit, unit_cost_cents, suggested_price_cents"
      )
      .or(`code.ilike.${like},description.ilike.${like},vendor.ilike.${like}`)
      .order("code", { ascending: true })
      .limit(25)
    if (error) return { ok: false, error: cleanCatalogError(error.message) }

    return { ok: true, items: (data ?? []) as CatalogRow[] }
  } catch (e) {
    // A misconfigured URL (e.g. the SpecMagician app URL instead of the
    // Supabase project URL) makes supabase-js receive HTML and throw while
    // parsing it as JSON — surface a short hint, never the raw page.
    return {
      ok: false,
      error: cleanCatalogError(e instanceof Error ? e.message : String(e)),
    }
  }
}

// PostgREST returns JSON errors, but if SPECMAGICIAN_SUPABASE_URL points at the
// wrong host (e.g. the SpecMagician web app instead of its Supabase project),
// the response is an HTML page and supabase-js hands back the raw markup as the
// error message. Never render that: detect it and return an actionable hint,
// and cap anything else so the picker can't blow up.
function cleanCatalogError(message: string): string {
  const msg = (message ?? "").trim()
  if (
    /<!doctype html|<html|<\/html>|Unexpected token '?<'?|is not valid JSON/i.test(
      msg
    )
  ) {
    return "Couldn't reach the catalog. Check that SPECMAGICIAN_SUPABASE_URL is the Supabase project URL (https://<ref>.supabase.co), not the SpecMagician app URL."
  }
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg || "Catalog search failed."
}
