import { NextResponse } from "next/server"
import { z } from "zod"
import { getSessionProfile } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { makeZip, type ZipEntry } from "@/lib/export/zip"

/**
 * Bulk insurance-document download for audits: POST a list of
 * insurance_documents ids, get back one ZIP with a folder per company
 * (COIs, W9s, and SMAs together). Runs under the caller's session — staff
 * RLS on insurance_documents and the staff Storage policy gate every read,
 * so a non-staff session gets nothing. POST (not GET) because a hundred
 * document ids don't fit comfortably in a query string.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Body = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(300),
})

const KIND_LABEL: Record<string, string> = {
  coi: "COI",
  w9: "W9",
  sma: "SMA",
}

// Path components inside the ZIP: strip separators and characters Windows
// refuses in filenames, collapse whitespace, cap the length.
function sanitizeZipComponent(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
      .trim() || "unnamed"
  )
}

export async function POST(req: Request) {
  const profile = await getSessionProfile()
  if (!profile) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  }
  if (profile.role !== "staff") {
    return NextResponse.json({ error: "Staff only" }, { status: 403 })
  }

  let parsed: z.infer<typeof Body>
  try {
    parsed = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Bad request body" }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const { data: docs, error } = await supabase
    .from("insurance_documents")
    .select(
      "id, file_name, doc_kind, storage_bucket, storage_path, received_at, companies(name)"
    )
    .in("id", parsed.documentIds)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!docs || docs.length === 0) {
    return NextResponse.json(
      { error: "No documents found for the selection" },
      { status: 404 }
    )
  }

  const entries: ZipEntry[] = []
  const usedNames = new Set<string>()
  const failures: string[] = []
  for (const doc of docs) {
    const { data: file, error: dlErr } = await supabase.storage
      .from(doc.storage_bucket)
      .download(doc.storage_path)
    if (dlErr || !file) {
      failures.push(
        `${doc.file_name}: ${dlErr?.message ?? "download returned nothing"}`
      )
      continue
    }
    const company = sanitizeZipComponent(
      (doc.companies as { name: string } | null)?.name ?? "Unassigned"
    )
    const kind = KIND_LABEL[doc.doc_kind] ?? doc.doc_kind.toUpperCase()
    // ASCII-only separator: the STORED zip writer doesn't set the UTF-8
    // name flag, and Windows' built-in extractor garbles non-ASCII names.
    const base = `${company}/${kind} - ${sanitizeZipComponent(doc.file_name)}`
    let name = base
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      const dot = base.lastIndexOf(".")
      name =
        dot > base.lastIndexOf("/")
          ? `${base.slice(0, dot)} (${n})${base.slice(dot)}`
          : `${base} (${n})`
    }
    usedNames.add(name.toLowerCase())
    entries.push({
      name,
      data: new Uint8Array(await file.arrayBuffer()),
    })
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: `Couldn't read any of the selected files. ${failures[0] ?? ""}` },
      { status: 500 }
    )
  }
  // Surface partial failures inside the ZIP itself — a silent gap in an
  // audit package is worse than a visible note about it.
  if (failures.length > 0) {
    entries.push({
      name: "EXPORT NOTES.txt",
      data: new TextEncoder().encode(
        `The following ${failures.length} file(s) could not be read and are missing from this export:\n\n` +
          failures.map((f) => `  - ${f}`).join("\n") +
          "\n"
      ),
    })
  }

  const zip = makeZip(entries)
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="insurance-documents-${stamp}.zip"`,
      "Cache-Control": "no-store",
    },
  })
}
