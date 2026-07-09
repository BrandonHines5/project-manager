import type { Enums } from "@/lib/db/types"

// Client-facing branding is driven by a project's type. Residential jobs
// present under Hines Homes; commercial jobs present under MJV Building Group.
// Per product decision, the color palette is shared — only the name + logo
// differ. A Brand carries the displayed name and the paths to its logo assets
// (a white square mark for the colored nav tiles and a full-color logo for
// light backgrounds such as the printable Pricing PDF).

export type Brand = {
  key: "hines" | "mjv"
  name: string
  /** White square mark for the brand-colored nav tiles (in /public). */
  mark: string
  /** Full-color logo for light backgrounds (PDF header, etc.). */
  logo: string
  /**
   * Square PNG used as the favicon + link-preview (og:image) on the public
   * tokenized pages (PO / bid). Kept a raster PNG on purpose: link-preview
   * crawlers (iMessage, WhatsApp, etc.) frequently refuse to render an SVG
   * og:image, so a real square PNG is what makes the sub's text preview show
   * the right brand instead of the app's default favicon.
   */
  icon: string
}

export const HINES_HOMES: Brand = {
  key: "hines",
  name: "Hines Homes",
  mark: "/brand/hines-mark.svg",
  logo: "/brand/hines-logo.svg",
  // The 512px navy-fence favicon that already ships as the app icon.
  icon: "/icon-512.png",
}

export const MJV_BUILDING_GROUP: Brand = {
  key: "mjv",
  name: "MJV Building Group",
  mark: "/brand/mjv-mark.svg",
  logo: "/brand/mjv-logo.svg",
  // Square MJV mark on white, generated from the real logo (see mjv-logo.svg).
  icon: "/brand/mjv-icon.png",
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
