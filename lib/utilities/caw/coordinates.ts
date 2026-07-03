// Overlay coordinates for the CAW form templates (PDF points, origin
// bottom-left, matching pdf-lib). Calibrated against the committed blank PDFs in
// ./templates by rendering a 25pt ruler grid and filled samples. If a template
// is ever replaced, re-run the calibration and adjust these numbers — nothing
// else needs to change.

export type { Pt, YesNo } from "../fill"
import type { Pt, YesNo } from "../fill"

// ---- New Service ("Request For Water Service Application") -----------------
// Page is 612 x 745.68 pts.
export const NEW_SERVICE = {
  text: {
    date: { x: 98, y: 559, maxWidth: 210 },
    serviceAddress: { x: 118, y: 538, maxWidth: 168 },
    city: { x: 295, y: 538, maxWidth: 95 },
    zip: { x: 445, y: 538, maxWidth: 95 },
    subdivision: { x: 165, y: 526, maxWidth: 128 },
    block: { x: 356, y: 526, maxWidth: 38 },
    lot: { x: 455, y: 526, maxWidth: 46 },
    existingBuildings: { x: 438, y: 340 },
    newBuildings: { x: 431, y: 329 },
    floors: { x: 424, y: 319 },
    unitsPerMeter: { x: 369, y: 308 },
    remarks: { x: 115, y: 240, size: 9, maxWidth: 430 },
    // Account-for-business block (constant builder info). The labels right-align
    // to a colon column at ~x214, so values start just past it (x220); the long
    // "Printed name..." label ends further right (x285).
    fullName: { x: 220, y: 182, maxWidth: 360 },
    ssnTin: { x: 220, y: 164, maxWidth: 360 },
    phone: { x: 220, y: 101, maxWidth: 170 },
    altPhone: { x: 470, y: 101, maxWidth: 120 },
    email: { x: 220, y: 84, maxWidth: 360 },
    fax: { x: 470, y: 84, maxWidth: 120 },
    mailingAddress: { x: 220, y: 49, maxWidth: 360 },
    preparerName: { x: 285, y: 29, maxWidth: 250 },
  } as Record<string, Pt>,
  // Single-select checkbox columns: X drawn at (x, startY - index*step), where
  // index is the option's position in the matching config array.
  columns: {
    landUse: { x: 76, startY: 496, step: 15.0 },
    typeOfService: { x: 203, startY: 496, step: 15.0 },
    buildingType: { x: 353, startY: 496, step: 15.0 },
  },
  // Requested meter size checkboxes (single row).
  meterY: 259,
  meterX: {
    "5/8": 77,
    "3/4": 148,
    "1": 218,
    "1 1/2": 288,
    "2": 357,
    "3": 427,
    "4": 499,
  } as Record<string, number>,
  // "____ (Yes) or ____ (No)" answer blanks — an X is drawn in the chosen one.
  yesno: {
    existingWaterService: { yes: { x: 293, y: 350 }, no: { x: 365, y: 350 } },
    multiStory: { yes: { x: 197, y: 319 }, no: { x: 260, y: 319 } },
    multiFamily: { yes: { x: 219, y: 308 }, no: { x: 295, y: 308 } },
    septicTank: { yes: { x: 371, y: 298 }, no: { x: 435, y: 298 } },
    publicSewer: { yes: { x: 324, y: 287 }, no: { x: 400, y: 287 } },
  } as Record<string, YesNo>,
} as const

// ---- Standpipe ("Agreement for Temporary Construction Standpipe") ----------
// Page is 612 x 792 pts.
export const STANDPIPE = {
  text: {
    applicantName: { x: 145, y: 277, maxWidth: 185 },
    date: { x: 372, y: 277, maxWidth: 170 },
    signature: { x: 178, y: 242, maxWidth: 150 },
    serviceAddress: { x: 402, y: 228, maxWidth: 145 },
    serviceAddress2: { x: 402, y: 200, maxWidth: 145 },
  } as Record<string, Pt>,
} as const

// ---- Contract ("Water Service Contract") ----------------------------------
// Page is 612 x 792 pts.
export const CONTRACT = {
  text: {
    applicantTop: { x: 105, y: 657, maxWidth: 150 },
    date: { x: 320, y: 657, maxWidth: 172 },
    mailingAddress: { x: 95, y: 613, maxWidth: 158 },
    serviceAddress: { x: 340, y: 613, maxWidth: 152 },
    applicantSignature: { x: 105, y: 64, maxWidth: 150 },
  } as Record<string, Pt>,
} as const
