// Minimal XLSX (Office Open XML spreadsheet) writer for client-side
// "Export to spreadsheet" downloads. Dependency-free and browser-safe:
// STORED (uncompressed) ZIP entries + inline-string worksheets are all
// Excel needs for a tabular export. The ZIP container itself lives in
// lib/export/zip.ts (shared with the insurance bulk-document download).

import { makeZip, type ZipEntry } from "./zip"

export type XlsxCell = string | number | null | undefined
export type XlsxSheet = { name: string; rows: XlsxCell[][] }

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// Strip control chars XML 1.0 forbids (everything below 0x20 except
// tab/newline, plus DEL), then escape markup characters.
function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// 0 → "A", 25 → "Z", 26 → "AA" (bijective base 26, no zero digit).
function columnRef(index: number): string {
  let n = index + 1
  let ref = ""
  while (n > 0) {
    ref = String.fromCharCode(65 + ((n - 1) % 26)) + ref
    n = Math.floor((n - 1) / 26)
  }
  return ref
}

// Excel sheet-name rules: no \ / : * ? [ ], max 31 chars, non-empty,
// unique within the workbook (case-insensitive).
function sanitizeSheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((sheet, i) => {
    const base = sheet.name.replace(/[\\/:*?[\]]/g, "").trim().slice(0, 31).trim()
    const fallback = base === "" ? `Sheet${i + 1}` : base
    let candidate = fallback
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`
      candidate = fallback.slice(0, 31 - suffix.length).trim() + suffix
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

function worksheetXml(rows: XlsxCell[][]): string {
  const rowsXml: string[] = []
  rows.forEach((row, ri) => {
    const cells: string[] = []
    row.forEach((value, ci) => {
      if (value === null || value === undefined || value === "") return
      const ref = `${columnRef(ci)}${ri + 1}`
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return
        cells.push(`<c r="${ref}" t="n"><v>${String(value)}</v></c>`)
      } else {
        cells.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
        )
      }
    })
    if (cells.length > 0) rowsXml.push(`<row r="${ri + 1}">${cells.join("")}</row>`)
  })
  return (
    XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowsXml.join("")}</sheetData>` +
    "</worksheet>"
  )
}

function workbookXml(names: string[]): string {
  const sheetsXml = names
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")
  return (
    XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetsXml}</sheets>` +
    "</workbook>"
  )
}

function workbookRelsXml(sheetCount: number): string {
  let rels = ""
  for (let i = 0; i < sheetCount; i++) {
    rels +=
      `<Relationship Id="rId${i + 1}"` +
      ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"' +
      ` Target="worksheets/sheet${i + 1}.xml"/>`
  }
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels +
    "</Relationships>"
  )
}

function rootRelsXml(): string {
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
    ' Target="xl/workbook.xml"/>' +
    "</Relationships>"
  )
}

function contentTypesXml(sheetCount: number): string {
  let overrides =
    '<Override PartName="/xl/workbook.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  for (let i = 0; i < sheetCount; i++) {
    overrides +=
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml"` +
      ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  }
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides +
    "</Types>"
  )
}

/** Builds a complete .xlsx file (ZIP container) as bytes. */
export function makeXlsx(sheets: XlsxSheet[]): Uint8Array {
  // A workbook must contain at least one sheet to be a valid file.
  const effective = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }]
  const names = sanitizeSheetNames(effective)
  const encoder = new TextEncoder()

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml(effective.length)) },
    { name: "_rels/.rels", data: encoder.encode(rootRelsXml()) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(names)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRelsXml(effective.length)) },
  ]
  effective.forEach((sheet, i) => {
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(worksheetXml(sheet.rows)),
    })
  })

  return makeZip(entries)
}
