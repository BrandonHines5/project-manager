// Which companies are REQUIRED to carry current insurance. Shared by the
// staff dashboard (client component) and the reminder cron (server), so no
// "server-only" import here.
//
// Only companies marked "Approved for Use" on the master list must have
// current GL/WC coverage — the rest ("Not Contacted", "Inactive", "Not for
// Hire", "Interviewed", "Insurance Requirement Waived", or no status) are
// not chased for certificates and aren't flagged as missing coverage.
// companies.status is free text maintained by staff (see migration 0055),
// hence the case-insensitive comparison.
export function companyRequiresInsurance(
  status: string | null | undefined
): boolean {
  return status?.trim().toLowerCase() === "approved for use"
}

// The coverage types we actually require and chase. Auto and umbrella are
// still extracted and stored, but they don't trigger reminders and aren't
// listed in the request email (matches the GL/WC-only dashboard columns).
export const REQUIRED_INSURANCE_TYPES = [
  "general_liability",
  "workers_comp",
] as const

export function isRequiredInsuranceType(type: string): boolean {
  return (REQUIRED_INSURANCE_TYPES as readonly string[]).includes(type)
}
