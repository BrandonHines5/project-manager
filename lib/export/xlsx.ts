// Minimal XLSX (Office Open XML spreadsheet) writer for client-side
// "Export to spreadsheet" downloads. Dependency-free and browser-safe:
// STORED (uncompressed) ZIP entries + inline-string worksheets are all
// Excel needs for a tabular export.

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

// --- ZIP container (STORED entries only) ---

// Fixed DOS timestamp (2020-01-01 00:00:00) so output is deterministic and
// we never touch Date in a client bundle. Any valid constant works — Excel
// ignores it.
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeU16(out: Uint8Array, pos: number, value: number): void {
  out[pos] = value & 0xff
  out[pos + 1] = (value >>> 8) & 0xff
}

function writeU32(out: Uint8Array, pos: number, value: number): void {
  out[pos] = value & 0xff
  out[pos + 1] = (value >>> 8) & 0xff
  out[pos + 2] = (value >>> 16) & 0xff
  out[pos + 3] = (value >>> 24) & 0xff
}

type ZipEntry = { name: string; data: Uint8Array }

function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }))

  const localSize = parts.reduce((sum, p) => sum + 30 + p.nameBytes.length + p.data.length, 0)
  const centralSize = parts.reduce((sum, p) => sum + 46 + p.nameBytes.length, 0)
  const out = new Uint8Array(localSize + centralSize + 22)

  let pos = 0
  const offsets: number[] = []
  for (const part of parts) {
    offsets.push(pos)
    writeU32(out, pos, 0x04034b50) // local file header signature
    writeU16(out, pos + 4, 20) // version needed to extract
    writeU16(out, pos + 6, 0) // general purpose flags
    writeU16(out, pos + 8, 0) // method: STORED
    writeU16(out, pos + 10, DOS_TIME)
    writeU16(out, pos + 12, DOS_DATE)
    writeU32(out, pos + 14, part.crc)
    writeU32(out, pos + 18, part.data.length) // compressed size
    writeU32(out, pos + 22, part.data.length) // uncompressed size
    writeU16(out, pos + 26, part.nameBytes.length)
    writeU16(out, pos + 28, 0) // extra field length
    out.set(part.nameBytes, pos + 30)
    out.set(part.data, pos + 30 + part.nameBytes.length)
    pos += 30 + part.nameBytes.length + part.data.length
  }

  const centralStart = pos
  parts.forEach((part, i) => {
    writeU32(out, pos, 0x02014b50) // central directory header signature
    writeU16(out, pos + 4, 20) // version made by
    writeU16(out, pos + 6, 20) // version needed to extract
    writeU16(out, pos + 8, 0) // general purpose flags
    writeU16(out, pos + 10, 0) // method: STORED
    writeU16(out, pos + 12, DOS_TIME)
    writeU16(out, pos + 14, DOS_DATE)
    writeU32(out, pos + 16, part.crc)
    writeU32(out, pos + 20, part.data.length) // compressed size
    writeU32(out, pos + 24, part.data.length) // uncompressed size
    writeU16(out, pos + 28, part.nameBytes.length)
    writeU16(out, pos + 30, 0) // extra field length
    writeU16(out, pos + 32, 0) // file comment length
    writeU16(out, pos + 34, 0) // disk number start
    writeU16(out, pos + 36, 0) // internal file attributes
    writeU32(out, pos + 38, 0) // external file attributes
    writeU32(out, pos + 42, offsets[i]) // local header offset
    out.set(part.nameBytes, pos + 46)
    pos += 46 + part.nameBytes.length
  })

  writeU32(out, pos, 0x06054b50) // end of central directory signature
  writeU16(out, pos + 4, 0) // disk number
  writeU16(out, pos + 6, 0) // central directory start disk
  writeU16(out, pos + 8, parts.length) // entries on this disk
  writeU16(out, pos + 10, parts.length) // total entries
  writeU32(out, pos + 12, centralSize)
  writeU32(out, pos + 16, centralStart)
  writeU16(out, pos + 20, 0) // comment length

  return out
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
