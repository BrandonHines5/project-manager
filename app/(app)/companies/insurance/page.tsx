import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { InsuranceClient } from "./insurance-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Insurance — Hines Homes" }

/**
 * Staff insurance dashboard: per-sub GL/WC coverage status, the review
 * queue for certificates that couldn't be auto-matched, and manual
 * upload / send-request tools. All data is staff-RLS'd; clients and
 * trades never reach this route (requireStaff redirects).
 */
export default async function InsurancePage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [
    { data: companies, error: companiesErr },
    { data: policies, error: policiesErr },
    { data: documents, error: documentsErr },
  ] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, type, email, contact_name, status, notifications_enabled")
      .order("name"),
    // Newest-first with a generous cap: if the table ever outgrows it, the
    // rows dropped are the OLDEST history, so current-coverage status (which
    // only needs the latest expiration per company+type) stays correct.
    supabase
      .from("insurance_policies")
      .select(
        "id, company_id, document_id, type, carrier, policy_number, effective_date, expiration_date, reminder_sent_at"
      )
      .order("expiration_date", { ascending: false })
      .limit(2000),
    supabase
      .from("insurance_documents")
      .select(
        "id, company_id, file_name, file_type, source, email_from, email_subject, status, extracted_company_name, extraction_error, received_at"
      )
      .order("received_at", { ascending: false })
      .limit(200),
  ])
  if (companiesErr) throw new Error(companiesErr.message)
  if (policiesErr) throw new Error(policiesErr.message)
  if (documentsErr) throw new Error(documentsErr.message)

  return (
    <InsuranceClient
      companies={(companies ?? []) as Pick<
        Tables<"companies">,
        | "id"
        | "name"
        | "type"
        | "email"
        | "contact_name"
        | "status"
        | "notifications_enabled"
      >[]}
      policies={policies ?? []}
      documents={documents ?? []}
    />
  )
}
