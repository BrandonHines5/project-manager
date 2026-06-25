// Central Arkansas Water (CAW) — provider config for "Initiate Utilities".
//
// Phase 1 applies for water service in the BUILDER's name (temporary
// construction service), so the applicant / account-holder block on every CAW
// form is constant builder info, NOT the homeowner. Replace the PLACEHOLDER_*
// values with Hines Homes' real details before go-live. The TIN is PII and is
// sourced from an env var (set in the Vercel dashboard), never committed.
//
// CAW_SUBMISSION_EMAIL and CAW_PAYMENT_URL are also placeholders for Brandon to
// supply: the new-service intake address, and the single shared pay-by-link URL
// CAW returns for every payment.

/** Builder identity used as the water-service applicant on all CAW forms. */
export const CAW_BUILDER = {
  /** Legal company name printed as the applicant / account name. */
  companyName: "Hines Homes, LLC",
  /** Federal Tax ID (EIN). PII — keep out of git, set CAW_BUILDER_TIN in Vercel. */
  tin: process.env.CAW_BUILDER_TIN ?? "",
  businessPhone: "501-802-8453",
  /** Optional alternate/secondary phone. */
  altPhone: "",
  email: "info@hineshomes.com",
  /** Builder's mailing address (where CAW sends correspondence/bills). */
  mailingAddress: "401 Commerce Drive, Maumelle, AR 72113",
  /** Default name printed as "person filling out this form" / signature. */
  preparerName: "Adam Verhalen",
} as const

/** Where the filled new-service forms are emailed (CAW new-construction intake). */
export const CAW_SUBMISSION_EMAIL =
  process.env.CAW_SUBMISSION_EMAIL ?? "NewConstruction@carkw.com"

/** The single shared CAW pay-by-link URL (same for every payment). */
export const CAW_PAYMENT_URL =
  process.env.CAW_PAYMENT_URL ?? "PLACEHOLDER_CAW_PAYMENT_URL"

// ---- ZIP lookup -----------------------------------------------------------
// The CRM has no ZIP column and project addresses are often just a street, so
// we resolve ZIP from the subdivision (most precise) and fall back to the city.
// Keys are normalized (lowercased, trimmed). Extend these as new subdivisions /
// cities come online — a missing match just leaves ZIP blank for the user to
// type. Most Hines Homes jobs are in Maumelle (72113).
export const CAW_ZIP_BY_SUBDIVISION: Record<string, string> = {
  "natural trail estates": "72113",
  "ridgeview trails": "72113",
}
export const CAW_ZIP_BY_CITY: Record<string, string> = {
  maumelle: "72113",
}

const normalizeKey = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase()

/**
 * Resolve a ZIP from subdivision (preferred) or city. Returns undefined when
 * neither is known, so callers leave the field blank rather than guessing.
 */
export function resolveCawZip(input: {
  subdivision?: string | null
  city?: string | null
}): string | undefined {
  const bySub = CAW_ZIP_BY_SUBDIVISION[normalizeKey(input.subdivision)]
  if (bySub) return bySub
  const byCity = CAW_ZIP_BY_CITY[normalizeKey(input.city)]
  if (byCity) return byCity
  return undefined
}

/**
 * Whether enough is configured to EMAIL a valid application to CAW: the full
 * builder identity plus the intake address. Deliberately NOT gated on the TIN
 * (CAW doesn't require it for a business account, and it's supplied via env
 * when/if needed) or on CAW_PAYMENT_URL (only used later, at the
 * awaiting_payment step — not at send time). The UI uses this to enable "Send".
 */
export function isCawConfigured(): boolean {
  const b = CAW_BUILDER
  const builderReady = [
    b.companyName,
    b.businessPhone,
    b.email,
    b.mailingAddress,
    b.preparerName,
  ].every((v) => v.length > 0 && !v.startsWith("PLACEHOLDER_"))
  return builderReady && !CAW_SUBMISSION_EMAIL.startsWith("PLACEHOLDER_")
}

// ---- Option enumerations (mirror the CAW PDF checkboxes/selects) ----------

export const CAW_LAND_USE = [
  { value: "single_family_residence", label: "Single-Family Residence" },
  { value: "manufactured_home_park", label: "Manufactured Home/Park" },
  { value: "multi_family_residence", label: "Multi-Family Residence" },
  { value: "educational", label: "Educational" },
  { value: "recreational", label: "Recreational" },
  { value: "church", label: "Church" },
  { value: "governmental", label: "Governmental" },
  { value: "commercial", label: "Commercial" },
  { value: "industrial", label: "Industrial" },
  { value: "park", label: "Park" },
  { value: "other", label: "Other" },
] as const

export const CAW_TYPE_OF_SERVICE = [
  { value: "single_family_residence", label: "Single Family Residence" },
  { value: "multi_family_residence", label: "Multi-Family Residence" },
  { value: "multi_family_commercial", label: "Multi-Family Commercial" },
  { value: "commercial", label: "Commercial" },
  { value: "irrigation_sprinkler", label: "Irrigation/ Sprinkler" },
  { value: "private_fire_service", label: "Private Fire Service" },
] as const

export const CAW_BUILDING_TYPE = [
  { value: "house", label: "House" },
  { value: "manufactured_home", label: "Manufactured Home" },
  { value: "church", label: "Church" },
  { value: "governmental_building", label: "Governmental Building" },
  { value: "school", label: "School" },
  { value: "business", label: "Business" },
  { value: "recreational", label: "Recreational" },
  { value: "none", label: "None" },
  { value: "other", label: "Other" },
] as const

export const CAW_METER_SIZES = [
  "5/8",
  "3/4",
  "1",
  "1 1/2",
  "2",
  "3",
  "4",
] as const

export type CawLandUse = (typeof CAW_LAND_USE)[number]["value"]
export type CawTypeOfService = (typeof CAW_TYPE_OF_SERVICE)[number]["value"]
export type CawBuildingType = (typeof CAW_BUILDING_TYPE)[number]["value"]
export type CawMeterSize = (typeof CAW_METER_SIZES)[number]

// Per Brandon: for Hines Homes new construction these three are ALWAYS the
// same, so they're fixed constants stamped on the form (not asked in the UI).
export const CAW_FIXED = {
  landUse: "single_family_residence" as CawLandUse,
  typeOfService: "single_family_residence" as CawTypeOfService,
  buildingType: "house" as CawBuildingType,
} as const

// Meter size is 5/8 unless the home is larger than this many sq ft, in which
// case the UI prompts the user to confirm/choose a larger meter.
export const CAW_METER_PROMPT_SQFT = 4000

/** Residential new-construction defaults (overridable in the form UI). */
export const CAW_DEFAULTS = {
  ...CAW_FIXED,
  existingWaterService: false,
  existingBuildings: 0,
  newBuildings: 1,
  multiStory: false,
  floors: "",
  multiFamily: false,
  unitsPerMeter: "",
  septicTank: false,
  publicSewer: true,
  squareFootage: "",
  meterSize: "5/8" as CawMeterSize,
  includeStandpipe: true,
} as const
