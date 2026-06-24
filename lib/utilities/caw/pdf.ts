// CAW form fill engine.
//
// The three CAW forms are flat scanned PDFs with no AcroForm widgets, so we
// "fill" them by overlaying text (and X marks for checkboxes) at calibrated
// coordinates with pdf-lib. pdf-lib never decodes the underlying scan image —
// it parses the page structure and appends our drawing ops — so the JBIG2 /
// JPEG2000 backgrounds pass through untouched.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import {
  CAW_LAND_USE,
  CAW_TYPE_OF_SERVICE,
  CAW_BUILDING_TYPE,
  type CawLandUse,
  type CawTypeOfService,
  type CawBuildingType,
  type CawMeterSize,
} from "./config"
import { NEW_SERVICE, STANDPIPE, CONTRACT, type Pt, type YesNo } from "./coordinates"

/** Fully-resolved values to stamp onto the forms (built by the server action). */
export type CawRenderData = {
  // Property
  date: string
  serviceAddress: string
  city: string
  zip: string
  subdivision: string
  block: string
  lot: string
  // Single-selects
  landUse: CawLandUse
  typeOfService: CawTypeOfService
  buildingType: CawBuildingType
  meterSize: CawMeterSize
  // Yes/No + counts
  existingWaterService: boolean
  existingBuildings: string
  newBuildings: string
  multiStory: boolean
  floors: string
  multiFamily: boolean
  unitsPerMeter: string
  septicTank: boolean
  publicSewer: boolean
  remarks: string
  // Applicant / account (builder constants)
  applicantName: string
  tin: string
  phone: string
  altPhone: string
  email: string
  fax: string
  mailingAddress: string
  preparerName: string
  // Whether to also produce the standpipe agreement
  includeStandpipe: boolean
}

export type CawFormKey = "new_service" | "contract" | "standpipe"
export type FilledForm = { key: CawFormKey; filename: string; bytes: Uint8Array }

const DEFAULT_SIZE = 10
const MIN_SIZE = 6
const INK = rgb(0, 0, 0.55) // dark blue, like a pen, so it reads as fill-in

function templateCandidates(name: string): string[] {
  const rel = path.join("lib", "utilities", "caw", "templates", name)
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return ""
    }
  })()
  return [
    path.join(process.cwd(), rel),
    here ? path.join(here, "templates", name) : "",
  ].filter(Boolean)
}

function loadTemplate(name: string): Buffer {
  const tried: string[] = []
  for (const p of templateCandidates(name)) {
    tried.push(p)
    if (fs.existsSync(p)) return fs.readFileSync(p)
  }
  throw new Error(`CAW template "${name}" not found. Looked in: ${tried.join(", ")}`)
}

/**
 * Coerce text into characters the standard (WinAnsi) font can encode.
 * pdf-lib's drawText THROWS on any glyph outside WinAnsi/CP1252, and the
 * service address / remarks / subdivision are free-typed — a pasted em dash,
 * curly quote, or non-Latin character would otherwise crash form generation.
 * We map common typographics to ASCII and drop anything still unencodable.
 */
function sanitizeWinAnsi(s: string): string {
  return s
    .replace(/[‘’‚′‵]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/•/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    // Keep printable ASCII + Latin-1 letters; strip the rest (emoji, CJK, C1).
    .replace(/[^\x20-\x7E¡-ÿ]/g, "")
}

/** Draw text, shrinking the font (down to MIN_SIZE) so it fits maxWidth. */
function drawText(page: PDFPage, font: PDFFont, value: string, pos: Pt) {
  const text = sanitizeWinAnsi((value ?? "").trim())
  if (!text) return
  let size = pos.size ?? DEFAULT_SIZE
  if (pos.maxWidth) {
    while (size > MIN_SIZE && font.widthOfTextAtSize(text, size) > pos.maxWidth) {
      size -= 0.5
    }
  }
  page.drawText(text, { x: pos.x, y: pos.y, size, font, color: INK })
}

/** Draw an "X" mark centered-ish on a checkbox / answer blank. */
function drawMark(page: PDFPage, font: PDFFont, pos: { x: number; y: number }) {
  page.drawText("X", { x: pos.x, y: pos.y, size: 11, font, color: INK })
}

function drawYesNo(page: PDFPage, font: PDFFont, group: YesNo, value: boolean) {
  drawMark(page, font, value ? group.yes : group.no)
}

export async function fillNewService(data: CawRenderData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(loadTemplate("new-service.pdf"))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.getPage(0)
  const T = NEW_SERVICE.text

  const text: Record<string, string> = {
    date: data.date,
    serviceAddress: data.serviceAddress,
    city: data.city,
    zip: data.zip,
    subdivision: data.subdivision,
    block: data.block,
    lot: data.lot,
    existingBuildings: data.existingBuildings,
    newBuildings: data.newBuildings,
    floors: data.multiStory ? data.floors : "",
    unitsPerMeter: data.multiFamily ? data.unitsPerMeter : "",
    remarks: data.remarks,
    fullName: data.applicantName,
    ssnTin: data.tin,
    phone: data.phone,
    altPhone: data.altPhone,
    email: data.email,
    fax: data.fax,
    mailingAddress: data.mailingAddress,
    preparerName: data.preparerName,
  }
  for (const [key, pos] of Object.entries(T)) {
    if (text[key] !== undefined) drawText(page, font, text[key], pos)
  }

  // Single-select checkbox columns.
  markColumn(page, font, NEW_SERVICE.columns.landUse, indexOf(CAW_LAND_USE, data.landUse))
  markColumn(page, font, NEW_SERVICE.columns.typeOfService, indexOf(CAW_TYPE_OF_SERVICE, data.typeOfService))
  markColumn(page, font, NEW_SERVICE.columns.buildingType, indexOf(CAW_BUILDING_TYPE, data.buildingType))

  // Requested meter size.
  const mx = NEW_SERVICE.meterX[data.meterSize]
  if (mx !== undefined) drawMark(page, font, { x: mx, y: NEW_SERVICE.meterY })

  // Yes/No answer blanks.
  drawYesNo(page, font, NEW_SERVICE.yesno.existingWaterService, data.existingWaterService)
  drawYesNo(page, font, NEW_SERVICE.yesno.multiStory, data.multiStory)
  drawYesNo(page, font, NEW_SERVICE.yesno.multiFamily, data.multiFamily)
  drawYesNo(page, font, NEW_SERVICE.yesno.septicTank, data.septicTank)
  drawYesNo(page, font, NEW_SERVICE.yesno.publicSewer, data.publicSewer)

  return doc.save()
}

export async function fillStandpipe(data: CawRenderData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(loadTemplate("standpipe.pdf"))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.getPage(0)
  const T = STANDPIPE.text
  // The standpipe has "Print Name" + "Signature" (person-oriented), so it uses
  // the preparer's name rather than the company.
  drawText(page, font, data.preparerName, T.applicantName)
  drawText(page, font, data.date, T.date)
  drawText(page, font, data.preparerName, T.signature) // typed e-signature
  // Service address may wrap to the form's two-line slot.
  const addr = wrapAddress(data.serviceAddress)
  drawText(page, font, addr[0] ?? "", T.serviceAddress)
  if (addr[1]) drawText(page, font, addr[1], T.serviceAddress2)
  return doc.save()
}

export async function fillContract(data: CawRenderData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(loadTemplate("contract.pdf"))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.getPage(0)
  const T = CONTRACT.text
  drawText(page, font, data.applicantName, T.applicantTop)
  drawText(page, font, data.date, T.date)
  drawText(page, font, data.mailingAddress, T.mailingAddress)
  drawText(page, font, data.serviceAddress, T.serviceAddress)
  drawText(page, font, data.applicantName, T.applicantSignature) // typed e-signature
  return doc.save()
}

/** Fill the set of forms required for this request. */
export async function fillCawForms(data: CawRenderData): Promise<FilledForm[]> {
  const stamp = data.serviceAddress
    ? data.serviceAddress.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "caw"
  const forms: FilledForm[] = [
    { key: "new_service", filename: `CAW-New-Service-${stamp}.pdf`, bytes: await fillNewService(data) },
    { key: "contract", filename: `CAW-Water-Service-Contract-${stamp}.pdf`, bytes: await fillContract(data) },
  ]
  if (data.includeStandpipe) {
    forms.push({ key: "standpipe", filename: `CAW-Standpipe-${stamp}.pdf`, bytes: await fillStandpipe(data) })
  }
  return forms
}

// ---- helpers --------------------------------------------------------------

function indexOf<T extends { value: string }>(arr: readonly T[], value: string): number {
  return arr.findIndex((o) => o.value === value)
}

function markColumn(
  page: PDFPage,
  font: PDFFont,
  col: { x: number; startY: number; step: number },
  index: number
) {
  if (index < 0) return
  drawMark(page, font, { x: col.x, y: col.startY - index * col.step })
}

/** Greedy 2-line wrap for the standpipe's stacked service-address slot. */
function wrapAddress(addr: string): [string, string?] {
  const s = (addr ?? "").trim()
  if (s.length <= 30) return [s]
  // Prefer to break at the comma (street, city) if present.
  const comma = s.indexOf(",")
  if (comma > 0 && comma < s.length - 1) return [s.slice(0, comma).trim(), s.slice(comma + 1).trim()]
  const mid = s.lastIndexOf(" ", 30)
  if (mid > 0) return [s.slice(0, mid), s.slice(mid + 1)]
  // No comma and no early space: hard-split the long token so it spills onto the
  // form's second address line instead of overflowing the slot.
  const second = s.slice(30).trim()
  return [s.slice(0, 30).trim(), second || undefined]
}
