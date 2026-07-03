// Shared PDF fill helpers for utility-provider forms.
//
// Provider templates (CAW, Lumber One) are flat scanned PDFs with no AcroForm
// widgets, so we "fill" them by overlaying text (and marks) at calibrated
// coordinates with pdf-lib. pdf-lib never decodes the underlying scan image —
// it parses the page structure and appends our drawing ops — so the JBIG2 /
// JPEG2000 backgrounds pass through untouched.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { rgb, type PDFFont, type PDFPage } from "pdf-lib"

/** One positioned text slot on a form (PDF points, origin bottom-left). */
export type Pt = { x: number; y: number; size?: number; maxWidth?: number }
export type YesNo = { yes: Pt; no: Pt }

/** A filled, ready-to-store PDF. `key` names the form within its provider. */
export type FilledPdf = { key: string; filename: string; bytes: Uint8Array }

export const DEFAULT_SIZE = 10
export const MIN_SIZE = 6
export const INK = rgb(0, 0, 0.55) // dark blue, like a pen, so it reads as fill-in

/**
 * Load a blank form template from lib/utilities/{provider}/templates.
 * Tries the cwd-relative path first (Vercel/Next serverless keeps the repo
 * layout under cwd), then a path relative to this module for other runtimes.
 */
export function loadTemplate(provider: string, name: string): Buffer {
  const rel = path.join("lib", "utilities", provider, "templates", name)
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return ""
    }
  })()
  const candidates = [
    path.join(process.cwd(), rel),
    here ? path.join(here, provider, "templates", name) : "",
  ].filter(Boolean)
  const tried: string[] = []
  for (const p of candidates) {
    tried.push(p)
    if (fs.existsSync(p)) return fs.readFileSync(p)
  }
  throw new Error(
    `Form template "${provider}/${name}" not found. Looked in: ${tried.join(", ")}`
  )
}

/**
 * Coerce text into characters the standard (WinAnsi) font can encode.
 * pdf-lib's drawText THROWS on any glyph outside WinAnsi/CP1252, and several
 * slots are free-typed — a pasted em dash, curly quote, or non-Latin character
 * would otherwise crash form generation. We map common typographics to ASCII
 * and drop anything still unencodable.
 */
export function sanitizeWinAnsi(s: string): string {
  return s
    .replace(/[‘’‚′‵]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/•/g, "-")
    .replace(/…/g, "...")
    // Typographic spaces (NBSP, figure space, narrow NBSP) → plain space.
    // Escapes, not literals: the invisible characters were silently lost once
    // already when this code moved files.
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    // Keep printable ASCII + Latin-1 letters; strip the rest (emoji, CJK, C1).
    .replace(/[^\x20-\x7E¡-ÿ]/g, "")
}

/** Draw text, shrinking the font (down to MIN_SIZE) so it fits maxWidth. */
export function drawText(page: PDFPage, font: PDFFont, value: string, pos: Pt) {
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
export function drawMark(page: PDFPage, font: PDFFont, pos: { x: number; y: number }) {
  page.drawText("X", { x: pos.x, y: pos.y, size: 11, font, color: INK })
}

export function drawYesNo(page: PDFPage, font: PDFFont, group: YesNo, value: boolean) {
  drawMark(page, font, value ? group.yes : group.no)
}

/** A hand-drawn-style ellipse for "circle one" answers. */
export type Ellipse = { x: number; y: number; xScale: number; yScale: number }

export function drawCircle(page: PDFPage, e: Ellipse) {
  page.drawEllipse({
    x: e.x,
    y: e.y,
    xScale: e.xScale,
    yScale: e.yScale,
    borderColor: INK,
    borderWidth: 1.3,
  })
}
