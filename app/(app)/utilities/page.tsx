import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import {
  CAW_BUILDER,
  CAW_PAYMENT_URL,
  CAW_SUBMISSION_EMAIL,
  isCawConfigured,
} from "@/lib/utilities/caw/config"
import { UtilitiesClient, type UtilitiesData } from "./utilities-client"

export const metadata = { title: "Initiate Utilities — Hines Homes" }

/**
 * Initiate Utilities. Staff pick a job and the app fills out the utility
 * provider's official forms, emails them in, then tracks the request through
 * the external pay-by-link flow. Phase 1: Central Arkansas Water (CAW).
 */
export default async function UtilitiesPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [{ data: projects, error: pErr }, { data: requests, error: rErr }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, project_number, name, address, client_name")
        .order("project_number"),
      supabase
        .from("utility_requests")
        .select("*")
        .order("created_at", { ascending: false }),
    ])
  if (pErr) throw new Error(pErr.message)
  if (rErr) throw new Error(rErr.message)

  // Sign every generated file once so the client can render download links.
  const allPaths = (requests ?? []).flatMap((r) => r.generated_file_paths ?? [])
  const signed: Record<string, string> = {}
  if (allPaths.length) {
    const { data, error: signErr } = await supabase.storage
      .from("project-files")
      .createSignedUrls(allPaths, 3600)
    // Don't crash the whole page on a transient signing failure — log it so a
    // storage/RLS misconfig is visible, and render with whatever links we got.
    if (signErr) {
      console.warn("[utilities] signed URL generation failed:", signErr.message)
    }
    for (const d of data ?? []) {
      if (d.path && d.signedUrl) signed[d.path] = d.signedUrl
    }
  }

  const projById = new Map((projects ?? []).map((p) => [p.id, p]))

  const data: UtilitiesData = {
    projects: projects ?? [],
    requests: (requests ?? []).map((r) => {
      const p = projById.get(r.project_id)
      return {
        id: r.id,
        project_id: r.project_id,
        project_label: p ? `${p.project_number} — ${p.name}` : "Unknown project",
        provider: r.provider,
        status: r.status,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        form_data: (r.form_data ?? {}) as any,
        payment_url: r.payment_url,
        submitted_at: r.submitted_at,
        paid_at: r.paid_at,
        created_at: r.created_at,
        files: (r.generated_file_paths ?? []).map((path) => ({
          path,
          filename: path.split("/").pop() ?? "form.pdf",
          url: signed[path] ?? "",
        })),
      }
    }),
    builder: {
      companyName: CAW_BUILDER.companyName,
      email: CAW_BUILDER.email,
      phone: CAW_BUILDER.businessPhone,
      mailingAddress: CAW_BUILDER.mailingAddress,
      preparerName: CAW_BUILDER.preparerName,
      tinSet: !!CAW_BUILDER.tin,
    },
    configured: isCawConfigured(),
    paymentUrl: CAW_PAYMENT_URL,
    submissionEmail: CAW_SUBMISSION_EMAIL,
  }

  return <UtilitiesClient data={data} />
}
