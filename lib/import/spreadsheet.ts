// Minimal .xlsx / .csv reader for the budget spreadsheet import — the read
// counterpart to lib/export/xlsx.ts, and dependency-free for the same reason.
// Server-only: xlsx entries are DEFLATE-compressed and we lean on node:zlib
// rather than shipping an inflater (call it from a server action, never from
// the browser).
//
// Scope is deliberately narrow: the first worksheet, cell text only. Shared
// strings, inline strings, formula results (cached <v>), booleans, and plain
// numbers all come back as strings; styles/dates/merges are ignored. That
// covers anything Excel or Google Sheets exports for a one-sheet budget.

import { inflateRawSync } from "node:zlib"

/** Parses a spreadsheet into rows of trimmed cell strings (empty cell = ""). */
export function parseSpreadsheet(
  filename: string,
  data: Buffer
): string[][] {
  const isXlsx =
    /\.xlsx$/i.test(filename) ||
    // zip magic — catches renamed files regardless of extension
    (data.length > 4 && data.readUInt32LE(0) === 0x04034b50)
  return isXlsx ? parseXlsx(data) : parseCsv(data)
}

// ---- csv -------------------------------------------------------------------

function parseCsv(data: Buffer): string[][] {
  let text = data.toString("utf8")
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      field = ""
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim()))
}

// ---- xlsx ------------------------------------------------------------------

function parseXlsx(data: Buffer): string[][] {
  const entries = readZip(data)
  const sheetPath = firstSheetPath(entries)
  const sheetXml = entries.get(sheetPath)
  if (!sheetXml) throw new Error("Couldn't find a worksheet in this .xlsx file")
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml"))
  return parseSheet(sheetXml.toString("utf8"), shared)
}

/**
 * Reads a zip's entries via the central directory (EOCD scan from the end).
 * Supports stored (0) and deflate (8) entries — everything Excel, Google
 * Sheets, and our own writer emit. No zip64: budget sheets are tiny.
 */
function readZip(data: Buffer): Map<string, Buffer> {
  // EOCD record: signature + a variable-length comment (max 64k) at the end.
  let eocd = -1
  const scanFrom = Math.max(0, data.length - 22 - 65535)
  for (let i = data.length - 22; i >= scanFrom; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no zip directory)")
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)

  const entries = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) break
    const method = data.readUInt16LE(offset + 10)
    const compressedSize = data.readUInt32LE(offset + 20)
    const nameLen = data.readUInt16LE(offset + 28)
    const extraLen = data.readUInt16LE(offset + 30)
    const commentLen = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLen)

    // The local header repeats name/extra with its own (possibly different)
    // lengths — the data starts after those, not the central copy's.
    const localNameLen = data.readUInt16LE(localOffset + 26)
    const localExtraLen = data.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = data.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))

    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Resolves the workbook's first sheet tab to its worksheet part path. */
function firstSheetPath(entries: Map<string, Buffer>): string {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8")
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8")
  const rid = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1]
  if (rid && rels) {
    const rel = new RegExp(
      `<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`
    ).exec(rels)
    // Also match attribute order Target-before-Id.
    const target =
      rel?.[1] ??
      new RegExp(
        `<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`
      ).exec(rels)?.[1]
    if (target) {
      return target.startsWith("/") ? target.slice(1) : `xl/${target}`
    }
  }
  return "xl/worksheets/sheet1.xml"
}

function parseSharedStrings(xml?: Buffer): string[] {
  if (!xml) return []
  const out: string[] = []
  const text = xml.toString("utf8")
  const si = /<si>([\s\S]*?)<\/si>|<si\/>/g
  let m: RegExpExecArray | null
  while ((m = si.exec(text))) {
    out.push(m[1] ? concatTexts(m[1]) : "")
  }
  return out
}

/** Concatenates every <t> run inside a fragment (rich text = multiple runs). */
function concatTexts(fragment: string): string {
  let s = ""
  const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g
  let m: RegExpExecArray | null
  while ((m = t.exec(fragment))) s += decodeEntities(m[1] ?? "")
  return s
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = []
    let lastCol = -1
    let cm: RegExpExecArray | null
    cellRe.lastIndex = 0
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1]
      const body = cm[2] ?? ""
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
      const col = ref ? colIndex(ref) : lastCol + 1
      lastCol = col
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n"

      let value = ""
      if (type === "inlineStr") {
        value = concatTexts(body)
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
        if (v != null) {
          const raw = decodeEntities(v)
          if (type === "s") value = shared[Number(raw)] ?? ""
          else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE"
          else if (type === "e") value = ""
          else value = raw // n, str, d
        }
      }
      while (cells.length < col) cells.push("")
      cells[col] = value.trim()
    }
    rows.push(cells)
  }
  return rows
}

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}
