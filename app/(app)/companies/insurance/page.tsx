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

  // The dashboard only consumes two document sets, so query them directly
  // instead of a capped catch-all (which could silently drop an old
  // unresolved doc or a company's only W9 as COI volume grows):
  //   * unresolved docs (any kind) — the review queue
  //   * processed W9s/SMAs — the Docs chips, expanded-row lists, and export
  // Processed COIs aren't needed here at all: cert links resolve through
  // insurance_policies.document_id.
  const DOC_SELECT =
    "id, company_id, file_name, file_type, source, doc_kind, email_from, email_subject, status, extracted_company_name, extraction_error, received_at"
  const [
    { data: companies, error: companiesErr },
    { data: policies, error: policiesErr },
    { data: unresolvedDocs, error: unresolvedErr },
    { data: extraDocs, error: extraErr },
  ] = await Promise.all([
    supabase
      .from("companies")
      .select(
        "id, name, aka, type, email, contact_name, status, notifications_enabled, insurance_agent_name, insurance_agent_email, insurance_agent_phone"
      )
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
      .select(DOC_SELECT)
      .in("status", ["pending", "needs_review", "failed"])
      .order("received_at", { ascending: false })
      .limit(500),
    supabase
      .from("insurance_documents")
      .select(DOC_SELECT)
      .in("doc_kind", ["w9", "sma"])
      .eq("status", "processed")
      .order("received_at", { ascending: false })
      .limit(2000),
  ])
  if (companiesErr) throw new Error(companiesErr.message)
  if (policiesErr) throw new Error(policiesErr.message)
  if (unresolvedErr) throw new Error(unresolvedErr.message)
  if (extraErr) throw new Error(extraErr.message)
  const documents = [...(unresolvedDocs ?? []), ...(extraDocs ?? [])]

  return (
    <InsuranceClient
      companies={(companies ?? []) as Pick<
        Tables<"companies">,
        | "id"
        | "name"
        | "aka"
        | "type"
        | "email"
        | "contact_name"
        | "status"
        | "notifications_enabled"
        | "insurance_agent_name"
        | "insurance_agent_email"
        | "insurance_agent_phone"
      >[]}
      policies={policies ?? []}
      documents={documents}
    />
  )
}
