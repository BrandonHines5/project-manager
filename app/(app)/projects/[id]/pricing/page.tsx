import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { brandForProjectType } from "@/lib/brand"
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
    .select("id, name, project_number, contract_price, project_type, address")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const brand = brandForProjectType(project.project_type)

  // Committed costs = approved POs. Staff-only money-out data (what we pay
  // subs) — never fetched for clients, and the client component additionally
  // gates the section on financial_access.
  const canSeeCommitted = profile.role === "staff" && !!profile.financial_access

  const [{ data: decisions }, { data: payments }, approvedPosRes] =
    await Promise.all([
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
      canSeeCommitted
        ? supabase
            .from("purchase_orders")
            .select(
              `id, number, title, flat_fee, flat_total, work_complete,
               companies:company_id ( name ),
               po_line_items ( quantity, unit_cost, cost_codes:cost_code_id ( code, name ) )`
            )
            .eq("project_id", projectId)
            .eq("status", "approved")
            .order("number", { ascending: true })
        : Promise.resolve({ data: null, error: null }),
    ])

  // A failed committed-costs query must not render as "no committed costs".
  if (canSeeCommitted && approvedPosRes.error) {
    throw new Error(approvedPosRes.error.message)
  }

  const committedPos = (approvedPosRes.data ?? []).map((po) => {
    const p = po as unknown as {
      id: string
      number: number
      title: string
      flat_fee: boolean
      flat_total: number | null
      work_complete: boolean
      companies: { name: string } | null
      po_line_items: {
        quantity: number
        unit_cost: number
        cost_codes: { code: string; name: string } | null
      }[]
    }
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      flat_fee: p.flat_fee,
      flat_total: p.flat_total,
      work_complete: p.work_complete,
      company_name: p.companies?.name ?? "—",
      line_items: (p.po_line_items ?? []).map((li) => ({
        quantity: li.quantity,
        unit_cost: li.unit_cost,
        cost_code_code: li.cost_codes?.code ?? null,
        cost_code_name: li.cost_codes?.name ?? null,
      })),
    }
  })

  const data: PricingData = {
    project_id: projectId,
    project_name: project.name,
    project_number: project.project_number,
    project_address: project.address,
    role: profile.role,
    contract_price: project.contract_price,
    approved_decisions: decisions ?? [],
    payments: payments ?? [],
    financial_access: canSeeCommitted,
    committed_pos: committedPos,
    brand: {
      name: brand.name,
      logo: brand.logo,
    },
  }

  return <PricingClient data={data} />
}
