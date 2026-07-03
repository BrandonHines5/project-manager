// Overlay coordinates for the Lumber One "New Job Set-Up Request Form" (PDF
// points, origin bottom-left, matching pdf-lib). Calibrated against the
// committed blank template in ./templates by rendering a 25pt ruler grid and
// filled samples at 300 DPI. The scan has a slight downward skew to the right,
// so same-row fields carry individually measured y values. If the template is
// ever replaced, re-run the calibration and adjust these numbers — nothing
// else needs to change.
//
// Salesperson Initials/Number, Acct #, Bond Type, and Estimated Sales are
// deliberately absent: they stay blank on the form (see ./config.ts).

import type { Pt } from "../fill"
import type { Ellipse } from "../fill"

// Page is 610.56 x 788.4 pts.
export const NEW_JOB_SETUP = {
  text: {
    date: { x: 440, y: 592, maxWidth: 135 },
    customerName: { x: 150, y: 563, maxWidth: 245 },
    jobName: { x: 110, y: 528, maxWidth: 180 },
    lotSubdivision: { x: 437, y: 523, maxWidth: 140 },
    streetAddress: { x: 180, y: 489, maxWidth: 390 },
    city: { x: 72, y: 451, maxWidth: 175 },
    zip: { x: 318, y: 450, maxWidth: 45 },
    county: { x: 448, y: 448, maxWidth: 128 },
    propertyOwner: { x: 332, y: 271, maxWidth: 240 },
  } as Record<string, Pt>,
  // The four ruled lines under "Delivery Directions, Truck Requirements/
  // Restrictions, and Special Instructions" — free text wraps across them.
  deliveryLines: [
    { x: 36, y: 187.5, maxWidth: 540 },
    { x: 36, y: 161.5, maxWidth: 540 },
    { x: 36, y: 135.5, maxWidth: 540 },
    { x: 36, y: 109.5, maxWidth: 540 },
  ] as Pt[],
  // "circle one" answers get a pen-style ellipse around the chosen word.
  circles: {
    cityLimitsYes: { x: 264, y: 420, xScale: 24, yScale: 11 },
    cityLimitsNo: { x: 371, y: 419, xScale: 20, yScale: 11 },
    // Job Type is always Residential / New Construction for Hines Homes.
    residentialNewConstruction: { x: 270, y: 361, xScale: 60, yScale: 12 },
  } as Record<string, Ellipse>,
} as const
