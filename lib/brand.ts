import type { Enums } from "@/lib/db/types"

// Client-facing branding is driven by a project's type. Residential jobs
// present under Hines Homes; commercial jobs present under MJV Building Group.
// Per product decision, the color palette is shared — only the name + logo
// differ. A Brand carries the displayed name and the paths to its logo assets
// (a white square mark for the colored nav tiles and a full-color logo for
// light backgrounds such as the printable Pricing PDF).

export type Brand = {
  /**
   * Stable identifier. "hines" keeps its special tile-fill rendering in
   * BrandTile; org-configured brands can use any slug.
   */
  key: string
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
  // The real logo is square and self-contained (full color on white), so the
  // nav mark and the light-background logo are the same asset.
  mark: "/brand/mjv-logo.svg",
  logo: "/brand/mjv-logo.svg",
  // 512px raster of the same logo — link-preview crawlers need a PNG, not SVG.
  icon: "/brand/mjv-icon.png",
}

/**
 * An org's client-facing branding (Stage B3): the default brand plus an
 * optional commercial sub-brand that commercial project types present under.
 * Stored as `organizations.settings.brands` and parsed with
 * `parseBrandConfig`; org #1 is seeded with the historical Hines/MJV values,
 * so behavior there is unchanged.
 */
export type BrandConfig = {
  default: Brand
  commercial?: Brand
}

/**
 * The pre-B3 static config — Hines Homes with the MJV commercial sub-brand.
 * Call sites without an org context (the login page, static fallbacks) keep
 * using this, which is exactly the old hardcoded behavior.
 */
export const DEFAULT_BRAND_CONFIG: BrandConfig = {
  default: HINES_HOMES,
  commercial: MJV_BUILDING_GROUP,
}

function parseBrand(v: unknown): Brand | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.key !== "string" || typeof o.name !== "string" || !o.name.trim()) {
    return null
  }
  const str = (x: unknown, fallback: string): string =>
    typeof x === "string" && x.trim() ? x : fallback
  return {
    key: o.key,
    name: o.name,
    mark: str(o.mark, "/brand/buildfox-mark.svg"),
    logo: str(o.logo, "/brand/buildfox-mark.svg"),
    icon: str(o.icon, "/icon-512.png"),
  }
}

/**
 * Parse `organizations.settings` into a BrandConfig. A missing or malformed
 * `brands` block degrades to a neutral app-branded default carrying the org's
 * NAME (never another org's logos); a missing commercial entry just means the
 * org has no commercial sub-brand.
 */
export function parseBrandConfig(
  settings: unknown,
  orgName?: string | null
): BrandConfig {
  const brands =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).brands
      : null
  const def = parseBrand(
    brands && typeof brands === "object"
      ? (brands as Record<string, unknown>).default
      : null
  )
  const commercial = parseBrand(
    brands && typeof brands === "object"
      ? (brands as Record<string, unknown>).commercial
      : null
  )
  if (!def) {
    return {
      default: {
        key: "org",
        name: orgName?.trim() || "BuildFox",
        mark: "/brand/buildfox-mark.svg",
        logo: "/brand/buildfox-mark.svg",
        icon: "/icon-512.png",
      },
      ...(commercial ? { commercial } : {}),
    }
  }
  return { default: def, ...(commercial ? { commercial } : {}) }
}

export const PROJECT_TYPE_LABEL: Record<Enums<"project_type">, string> = {
  residential_new: "Residential — New construction",
  residential_remodel: "Residential — Remodel / Addition",
  commercial_new: "Commercial — New construction",
  commercial_remodel: "Commercial — Remodel / Addition",
}

/**
 * Brand for a single project type. Commercial → the org's commercial
 * sub-brand (when it has one); everything else (residential, or unset) → the
 * org's default brand. Without a config this is the historical static rule:
 * commercial → MJV Building Group, otherwise Hines Homes.
 */
export function brandForProjectType(
  type: Enums<"project_type"> | null | undefined,
  config: BrandConfig = DEFAULT_BRAND_CONFIG
): Brand {
  return type === "commercial_new" || type === "commercial_remodel"
    ? config.commercial ?? config.default
    : config.default
}

/**
 * Brand to show a client across the whole app (e.g. the sidebar), derived from
 * the set of projects they can see. If every one of their projects is a
 * commercial job, present the commercial sub-brand; otherwise the default. A
 * client with no projects also gets the default.
 */
export function brandForProjectTypes(
  types: (Enums<"project_type"> | null | undefined)[],
  config: BrandConfig = DEFAULT_BRAND_CONFIG
): Brand {
  if (types.length === 0 || !config.commercial) return config.default
  const allCommercial = types.every(
    (t) => brandForProjectType(t, config) === config.commercial
  )
  return allCommercial ? config.commercial : config.default
}
