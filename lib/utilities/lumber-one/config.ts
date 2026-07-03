// Lumber One (lumber1.com) — provider config for "Initiate Utilities".
//
// Starting a job also means opening it with the lumber yard: the "New Job
// Set-Up Request Form" goes to Brad Hartwick at Lumber One. Per Brandon:
//   * Salesperson Initials/Number, Acct #, and Estimated Sales are left BLANK
//     on the form — Brad fills those in on his end.
//   * Job Type is always Residential / New Construction (circled on the form).
//   * Bond Type is commercial-only, so it stays blank too.
//   * Property Owner is Hines Homes when Hines owns the lot (the CRM job has a
//     positive land_price), otherwise the client's name.

import { CAW_BUILDER } from "../caw/config"

/** The Lumber One account is in the builder's name, same identity as CAW. */
export const LUMBER_ONE_CUSTOMER_NAME = CAW_BUILDER.companyName

/** Where the filled set-up form is emailed (Brad Hartwick at Lumber One). */
export const LUMBER_ONE_SUBMISSION_EMAIL =
  process.env.LUMBER_ONE_SUBMISSION_EMAIL ?? "bhartwick@lumber1.com"

/** Whether enough is configured to email a valid form to Lumber One. */
export function isLumberOneConfigured(): boolean {
  return (
    LUMBER_ONE_CUSTOMER_NAME.length > 0 &&
    !LUMBER_ONE_CUSTOMER_NAME.startsWith("PLACEHOLDER_") &&
    LUMBER_ONE_SUBMISSION_EMAIL.includes("@")
  )
}

// ---- County lookup ----------------------------------------------------------
// The form asks for the county; the CRM has no county column, so resolve it
// from the job's city (central-Arkansas coverage — extend as new markets come
// online). A missing match just leaves the field blank for the user to type.
export const COUNTY_BY_CITY: Record<string, string> = {
  maumelle: "Pulaski",
  "little rock": "Pulaski",
  "north little rock": "Pulaski",
  sherwood: "Pulaski",
  jacksonville: "Pulaski",
  roland: "Pulaski",
  scott: "Pulaski",
  wrightsville: "Pulaski",
  mayflower: "Faulkner",
  conway: "Faulkner",
  greenbrier: "Faulkner",
  vilonia: "Faulkner",
  cabot: "Lonoke",
  ward: "Lonoke",
  austin: "Lonoke",
  lonoke: "Lonoke",
  benton: "Saline",
  bryant: "Saline",
  alexander: "Saline",
  stuttgart: "Arkansas",
}

const normalizeKey = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase()

/** Resolve the county from the job's city; undefined when unknown. */
export function resolveCounty(city: string | null | undefined): string | undefined {
  return COUNTY_BY_CITY[normalizeKey(city)]
}

// ---- Delivery directions defaults -------------------------------------------
// Per Brandon: Stonebrook is gated, so its jobs always carry the gate code in
// "Delivery Directions"; everywhere else the field starts blank.
export const DELIVERY_NOTE_BY_SUBDIVISION: Record<string, string> = {
  stonebrook: "Gate Code 4003",
}

/** Standing delivery note for a subdivision ("" when there is none). */
export function defaultDeliveryDirections(
  subdivision: string | null | undefined
): string {
  return DELIVERY_NOTE_BY_SUBDIVISION[normalizeKey(subdivision)] ?? ""
}
