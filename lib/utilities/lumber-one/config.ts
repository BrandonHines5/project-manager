// Lumber One (lumber1.com) — provider notes for "Initiate Utilities".
//
// Starting a job also means opening it with the lumber yard: the "New Job
// Set-Up Request Form" goes to Brad Hartwick at Lumber One. Per Brandon:
//   * Salesperson Initials/Number, Acct #, and Estimated Sales are left BLANK
//     on the form — Brad fills those in on his end.
//   * Job Type is always Residential / New Construction (circled on the form).
//   * Bond Type is commercial-only, so it stays blank too.
//   * Property Owner is the builder when it owns the lot (the CRM job has a
//     positive land_price), otherwise the client's name.
//
// Since Stage B3 part 2 the customer identity (the builder), submission
// email, county lookup, and per-subdivision delivery notes are ORG SETTINGS
// (`organizations.settings.utilities`, resolved by
// lib/utilities/org-config.ts) — nothing org-specific remains in this file.
// It exists to keep the provider's form conventions documented next to its
// pdf/coordinates modules.

export {}
