import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { brandForProjectType } from "@/lib/brand"
import { PricingClient } from "./pricing-client"
import type { PricingData } from "./pricing-client"

export const metadata = { title: "Pricing — BuildFox" }

export default async function PricingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number, contract_price, project_type, address")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const brand = brandForProjectType(project.project_type)

  // Committed costs (approved-PO rollup) intentionally do NOT appear here —
  // money-out lives on the Budget tab's POs column (financial_access-gated).
  // Pricing is the client-facing contract picture: contract, approved
  // changes, and payments.
  const [
    { data: decisions, error: decisionsError },
    { data: payments, error: paymentsError },
  ] = await Promise.all([
    supabase
      .from("decisions")
      .select("id, number, title, kind, cost_delta, status, approved_at")
      .eq("project_id", projectId)
      .eq("status", "approved")
      .order("approved_at", { ascending: true }),
    supabase
      .from("project_payments")
      .select("*")
      .eq("project_id", projectId)
      // Hide soft-deleted payments from the staff view too; deleted payments
      // remain in the audit table for accountability but shouldn't clutter
      // the live ledger. Staff who need to inspect deletions can query
      // payment_audit directly.
      .is("deleted_at", null)
      .order("paid_on", { ascending: false }),
  ])
  // A transient query failure must error the page, never render as "no
  // approved changes / no payments" — this is financial data.
  if (decisionsError) throw new Error(decisionsError.message)
  if (paymentsError) throw new Error(paymentsError.message)

  const data: PricingData = {
    project_id: projectId,
    project_name: project.name,
    project_number: project.project_number,
    project_address: project.address,
    role: profile.role,
    contract_price: project.contract_price,
    approved_decisions: decisions ?? [],
    payments: payments ?? [],
    brand: {
      name: brand.name,
      logo: brand.logo,
    },
  }

  return <PricingClient data={data} />
}
