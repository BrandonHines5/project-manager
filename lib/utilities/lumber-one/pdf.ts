// Lumber One "New Job Set-Up Request Form" fill engine. The form is a flat
// scan filled by overlaying text at calibrated coordinates — see ../fill.ts
// for the shared drawing helpers and ./coordinates.ts for the slot positions.

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { NEW_JOB_SETUP } from "./coordinates"
import {
  drawText,
  drawCircle,
  loadTemplate,
  sanitizeWinAnsi,
  type FilledPdf,
  type Pt,
} from "../fill"

/** Fully-resolved values to stamp onto the form (built by the server action). */
export type LumberOneRenderData = {
  date: string
  customerName: string
  jobName: string
  lot: string
  subdivision: string
  streetAddress: string
  city: string
  zip: string
  county: string
  inCityLimits: boolean
  propertyOwner: string
  deliveryDirections: string
}

/** "Lot 42 / Stonebrook", or whichever half is known. */
function lotSubdivision(lot: string, subdivision: string): string {
  const l = lot.trim()
  const s = subdivision.trim()
  if (l && s) return `Lot ${l} / ${s}`
  if (l) return `Lot ${l}`
  return s
}

/**
 * Greedy word-wrap into at most `slots.length` lines at the given size.
 * Explicit newlines are respected. Returns null when the text doesn't fit —
 * unless `truncate`, which drops whatever is left past the last line.
 */
function layoutLines(
  font: PDFFont,
  text: string,
  slots: readonly Pt[],
  size: number,
  truncate: boolean
): string[] | null {
  const lines: string[] = []
  const paras = text.split(/\r?\n/)
  for (let p = 0; p < paras.length; p++) {
    let line = ""
    // Sanitize per paragraph — sanitizing the whole text first would STRIP the
    // newlines (they're outside WinAnsi's printable range) and merge paragraphs.
    for (const word of sanitizeWinAnsi(paras[p]).split(/\s+/).filter(Boolean)) {
      const width = slots[Math.min(lines.length, slots.length - 1)].maxWidth ?? 540
      const attempt = line ? `${line} ${word}` : word
      // A single over-wide word stays on its line; drawText shrinks it to fit.
      if (!line || font.widthOfTextAtSize(attempt, size) <= width) {
        line = attempt
      } else {
        lines.push(line)
        line = word
        if (lines.length >= slots.length) return truncate ? lines : null
      }
    }
    lines.push(line)
    if (lines.length >= slots.length) {
      if (p < paras.length - 1 && !truncate) return null
      break
    }
  }
  return lines.slice(0, slots.length)
}

/**
 * Wrap free text onto the form's ruled delivery-directions lines, trying
 * smaller fonts before truncating (the UI caps input length well before this).
 */
function wrapDeliveryLines(
  font: PDFFont,
  text: string,
  slots: readonly Pt[]
): { line: string; pos: Pt }[] {
  const clean = (text ?? "").trim()
  if (!sanitizeWinAnsi(clean).trim()) return []
  for (const size of [10, 9, 8]) {
    const lines = layoutLines(font, clean, slots, size, size === 8)
    if (lines) {
      return lines.map((line, i) => ({ line, pos: { ...slots[i], size } }))
    }
  }
  return []
}

export async function fillNewJobSetup(data: LumberOneRenderData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(loadTemplate("lumber-one", "new-job-setup.pdf"))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.getPage(0)
  const T = NEW_JOB_SETUP.text

  const text: Record<string, string> = {
    date: data.date,
    customerName: data.customerName,
    jobName: data.jobName,
    lotSubdivision: lotSubdivision(data.lot, data.subdivision),
    streetAddress: data.streetAddress,
    city: data.city,
    zip: data.zip,
    county: data.county,
    propertyOwner: data.propertyOwner,
  }
  for (const [key, pos] of Object.entries(T)) {
    if (text[key] !== undefined) drawText(page, font, text[key], pos)
  }

  for (const { line, pos } of wrapDeliveryLines(
    font,
    data.deliveryDirections,
    NEW_JOB_SETUP.deliveryLines
  )) {
    drawText(page, font, line, pos)
  }

  // "In City Limits? (circle one)"
  drawCircle(
    page,
    data.inCityLimits ? NEW_JOB_SETUP.circles.cityLimitsYes : NEW_JOB_SETUP.circles.cityLimitsNo
  )
  // Job Type: always Residential / New Construction for Hines Homes.
  drawCircle(page, NEW_JOB_SETUP.circles.residentialNewConstruction)

  return doc.save()
}

/** Fill the (single-form) Lumber One set. Mirrors fillCawForms' shape. */
export async function fillLumberOneForms(data: LumberOneRenderData): Promise<FilledPdf[]> {
  const stamp = data.streetAddress
    ? data.streetAddress.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "lumber-one"
  return [
    {
      key: "new_job_setup",
      filename: `Lumber-One-New-Job-Set-Up-${stamp}.pdf`,
      bytes: await fillNewJobSetup(data),
    },
  ]
}
