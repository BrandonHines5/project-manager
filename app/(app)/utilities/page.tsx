import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import {
  getUtilityConfig,
  isCawConfigured,
  isLumberOneConfigured,
} from "@/lib/utilities/org-config"
import { getActiveOrgId, LEGACY_ORG_ID } from "@/lib/org"
import { UtilitiesClient, type UtilitiesData, type UtilityJob } from "./utilities-client"

export const metadata = { title: "Initiate Utilities — BuildFox" }

// Raw shape we read from the CRM `projects` table (untyped client).
type CrmJobRow = {
  id: string
  project_number: string | null
  street_address: string | null
  city: string | null
  client_name: string | null
  project_status: string | null
}

/**
 * All active jobs (project_status 'In Work' or 'Upcoming') straight from the
 * CRM — utilities get initiated at the start of a job, usually before it's
 * being managed in this app, so the local projects table misses most of them.
 * Returns null when the CRM connection isn't configured or the query fails,
 * so the page can fall back to the local project list.
 */
async function fetchCrmJobs(): Promise<CrmJobRow[] | null> {
  const crm = createCrmClient()
  if (!crm) return null
  const { data, error } = await crm
    .from("projects")
    .select("id, project_number, street_address, city, client_name, project_status")
    .in("project_status", ["In Work", "Upcoming"])
    .order("project_number")
  if (error) {
    console.warn("[utilities] CRM job list failed:", error.message)
    return null
  }
  return (data ?? []) as CrmJobRow[]
}

/**
 * Initiate Utilities. Staff pick a job and the app fills out the provider
 * forms — CAW water service (tracked through the external pay-by-link flow)
 * and/or the Lumber One new-job set-up form (emailed to Brad) — in one pass.
 */
export default async function UtilitiesPage() {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  // Resolve the active org once — it gates the CRM read (Hines' external
  // system, legacy org only) and scopes the utility config.
  const orgId = await getActiveOrgId(supabase, me.id).catch(() => null)
  const isLegacy = orgId === LEGACY_ORG_ID

  const [
    { data: projects, error: pErr },
    { data: requests, error: rErr },
    crmJobs,
    cfg,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id, project_number, name, address, client_name")
      .order("project_number"),
    supabase
      .from("utility_requests")
      .select("*")
      .order("created_at", { ascending: false }),
    // CRM jobs come from Hines Homes' external CRM — legacy org only. Any
    // other org falls back to its own local project list for the Job dropdown.
    isLegacy ? fetchCrmJobs() : Promise.resolve(null),
    // The org's utility config (B3 part 2). Null = this org doesn't have the
    // Utilities module — the client renders its not-configured state.
    getUtilityConfig(supabase, orgId),
  ])
  if (pErr) throw new Error(pErr.message)
  if (rErr) throw new Error(rErr.message)

  const projById = new Map((projects ?? []).map((p) => [p.id, p]))
  const projByNumber = new Map((projects ?? []).map((p) => [p.project_number, p]))

  // The Job dropdown: active CRM jobs (linked to a local project when one
  // shares the project_number), or every local project when the CRM
  // connection isn't available.
  let jobs: UtilityJob[]
  if (crmJobs) {
    jobs = crmJobs.map((j) => {
      const local = j.project_number ? projByNumber.get(j.project_number) : undefined
      const place = j.street_address?.trim() || j.city?.trim() || "Unknown address"
      const client = j.client_name?.trim()
      const address =
        [j.street_address, j.city]
          .map((v) => v?.trim())
          .filter(Boolean)
          .join(", ") || null
      return {
        key: j.id,
        crm_project_id: j.id,
        project_id: local?.id ?? null,
        label: `${j.project_number ?? "?"} — ${place}${client ? ` (${client})` : ""}`,
        address,
        crm_status: j.project_status === "Upcoming" ? "Upcoming" : "In Work",
      } satisfies UtilityJob
    })
  } else {
    jobs = (projects ?? []).map((p) => ({
      key: p.id,
      crm_project_id: null,
      project_id: p.id,
      label: `${p.project_number} — ${p.name}`,
      address: p.address,
      crm_status: null,
    }))
  }

  // A draft's "Continue" button re-selects its job in the dropdown, so make
  // sure every draft's job is present even when it's no longer active in the
  // CRM (e.g. the job moved to Complete after the draft was saved).
  const jobKeys = new Set(jobs.map((j) => j.key))
  for (const r of requests ?? []) {
    if (r.status !== "draft") continue
    const covered = jobs.some(
      (j) =>
        (r.crm_project_id && j.crm_project_id === r.crm_project_id) ||
        (r.project_id && j.project_id === r.project_id)
    )
    if (covered) continue
    const key = r.crm_project_id ?? r.project_id
    if (!key || jobKeys.has(key)) continue
    jobKeys.add(key)
    const p = r.project_id ? projById.get(r.project_id) : undefined
    jobs.push({
      key,
      crm_project_id: r.crm_project_id,
      project_id: r.project_id,
      label:
        r.job_label ?? (p ? `${p.project_number} — ${p.name}` : "Unknown project"),
      address: p?.address ?? null,
      crm_status: null,
    })
  }

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

  const data: UtilitiesData = {
    jobs,
    jobsSource: crmJobs ? "crm" : "local",
    requests: (requests ?? []).map((r) => {
      const p = r.project_id ? projById.get(r.project_id) : undefined
      return {
        id: r.id,
        project_id: r.project_id,
        crm_project_id: r.crm_project_id,
        project_label:
          r.job_label ??
          (p ? `${p.project_number} — ${p.name}` : "Unknown project"),
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
      companyName: cfg?.builder.companyName ?? "",
      email: cfg?.builder.email ?? "",
      phone: cfg?.builder.businessPhone ?? "",
      mailingAddress: cfg?.builder.mailingAddress ?? "",
      preparerName: cfg?.builder.preparerName ?? "",
      tinSet: !!cfg?.builder.tin,
    },
    cawConfigured: cfg ? isCawConfigured(cfg) : false,
    lumberConfigured: cfg ? isLumberOneConfigured(cfg) : false,
    paymentUrl: cfg?.caw.paymentUrl ?? "",
    cawSubmissionEmail: cfg?.caw.submissionEmail ?? "",
    lumberSubmissionEmail: cfg?.lumberOne.submissionEmail ?? "",
  }

  return <UtilitiesClient data={data} />
}
