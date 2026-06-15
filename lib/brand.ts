import type { Enums } from "@/lib/db/types"

// Client-facing branding is driven by a project's type. Residential jobs
// present under Hines Homes; commercial jobs present under MJV Building Group.
// Per product decision, the color palette is shared — only the name + logo
// abbreviation differ — so a Brand is just the displayed name and its short
// logo mark.

export type Brand = {
  key: "hines" | "mjv"
  name: string
  /** Short mark shown in the square logo tile (no image asset needed). */
  abbr: string
}

export const HINES_HOMES: Brand = {
  key: "hines",
  name: "Hines Homes",
  abbr: "HH",
}

export const MJV_BUILDING_GROUP: Brand = {
  key: "mjv",
  name: "MJV Building Group",
  abbr: "MJV",
}

export const PROJECT_TYPE_LABEL: Record<Enums<"project_type">, string> = {
  residential_new: "Residential — New construction",
  residential_remodel: "Residential — Remodel / Addition",
  commercial_new: "Commercial — New construction",
  commercial_remodel: "Commercial — Remodel / Addition",
}

/**
 * Brand for a single project type. Commercial → MJV Building Group; everything
 * else (residential, or unset) → Hines Homes (the default house brand).
 */
export function brandForProjectType(
  type: Enums<"project_type"> | null | undefined
): Brand {
  return type === "commercial_new" || type === "commercial_remodel"
    ? MJV_BUILDING_GROUP
    : HINES_HOMES
}

/**
 * Brand to show a client across the whole app (e.g. the sidebar), derived from
 * the set of projects they can see. If every one of their projects is a
 * commercial (MJV) job, present MJV; otherwise fall back to Hines Homes. A
 * client with no projects also gets the default.
 */
export function brandForProjectTypes(
  types: (Enums<"project_type"> | null | undefined)[]
): Brand {
  if (types.length === 0) return HINES_HOMES
  const allMjv = types.every(
    (t) => brandForProjectType(t).key === "mjv"
  )
  return allMjv ? MJV_BUILDING_GROUP : HINES_HOMES
}
