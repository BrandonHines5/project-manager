import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { PricingClient } from "./pricing-client"
import type { PricingData } from "./pricing-client"

export const metadata = { title: "Pricing — Hines Homes" }

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
    .select("id, name, project_number, contract_price")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [{ data: decisions }, { data: payments }] = await Promise.all([
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

  const data: PricingData = {
    project_id: projectId,
    role: profile.role,
    contract_price: project.contract_price,
    approved_decisions: decisions ?? [],
    payments: payments ?? [],
  }

  return <PricingClient data={data} />
}
