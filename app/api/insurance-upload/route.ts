import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ingestInsuranceDocument } from "@/lib/insurance/ingest"
import { isExtractableType } from "@/lib/insurance/extract"

/**
 * Receives certificate uploads from the public /insurance-upload/{token}
 * page. Unauthenticated by design — the per-company upload token IS the
 * credential. It's validated against companies.insurance_upload_token and
 * only ever grants this one write path; everything runs server-side on the
 * admin client, so no RLS surface is opened to anonymous users.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// The upload triggers a Claude extraction pass before responding.
export const maxDuration = 300

const MAX_BYTES = 15 * 1024 * 1024

export async function POST(req: Request) {
  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Server is not configured for uploads" },
      { status: 500 }
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 })
  }

  const token = form.get("token")
  const file = form.get("file")
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ ok: false, error: "Invalid link" }, { status: 403 })
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file received" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "File is too large (15 MB max)" },
      { status: 413 }
    )
  }
  if (!isExtractableType(file.type)) {
    return NextResponse.json(
      { ok: false, error: "Please upload a PDF or an image (JPG/PNG)" },
      { status: 415 }
    )
  }

  const { data: company } = await admin
    .from("companies")
    .select("id")
    .eq("insurance_upload_token", token)
    .maybeSingle()
  if (!company) {
    return NextResponse.json({ ok: false, error: "Invalid link" }, { status: 403 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const result = await ingestInsuranceDocument({
    bytes,
    fileName: file.name || "certificate",
    fileType: file.type,
    fileSize: bytes.length,
    source: "upload",
    companyId: company.id,
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }
  // Even a failed extraction is a successful upload from the sub's point of
  // view — the file is stored and staff will see it in the review queue.
  return NextResponse.json({ ok: true })
}
