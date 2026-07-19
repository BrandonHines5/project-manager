// Central Arkansas Water (CAW) — provider config for "Initiate Utilities".
//
// Phase 1 applies for water service in the BUILDER's name (temporary
// construction service), so the applicant / account-holder block on every CAW
// form is constant builder info, NOT the homeowner.
//
// Since Stage B3 part 2 the builder identity, intake email, payment URL, and
// the ZIP lookup maps are ORG SETTINGS (`organizations.settings.utilities`,
// resolved by lib/utilities/org-config.ts) — this file keeps only the
// product-behavior constants: the option enumerations that mirror the CAW
// PDF, the always-the-same answers for residential new construction, and the
// meter-size prompt threshold.

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

// Per Brandon: for residential new construction these three are ALWAYS the
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
