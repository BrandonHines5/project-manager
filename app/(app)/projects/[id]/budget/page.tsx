import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { hasOrgFeature } from "@/lib/feature-gate"
import { EmptyState } from "@/components/ui/empty"
import { buildBudgetRows } from "@/lib/budget/rollup"
import type { DecisionForBudget, PoForBudget } from "@/lib/budget/rollup"
import { canEditBudget } from "@/app/actions/budget"
import { BudgetClient } from "./budget-client"

export const metadata = { title: "Budget — BuildFox" }

export default async function BudgetPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  // Staff-only tab (nav hides it from clients/trades; a pasted URL redirects).
  // Within staff, the whole page is money-out data — financial_access gates it
  // app-layer, same as the Pricing tab's committed costs.
  const profile = await requireStaff()
  if (!(await hasOrgFeature("budget", profile.id))) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10">
        <EmptyState
          title="Budget isn't included in your plan"
          description="Contact support to add budgeting to your subscription."
        />
      </div>
    )
  }
  if (!profile.financial_access) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10">
        <EmptyState
          title="Financial access required"
          description="The budget shows job costs. Ask an admin to enable financial access on your profile if you need it."
        />
      </div>
    )
  }

  // Read vs write: everyone past the financial_access gate can VIEW; only
  // the budget-editors allowlist (Settings → Budget editors) can MODIFY.
  const canEdit = await canEditBudget(profile.id)

  const supabase = await createSupabaseServerClient()
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: costCodes, error: ccErr },
    { data: lines, error: lErr },
    { data: actuals, error: aErr },
    { data: decisions, error: dErr },
    { data: pos, error: pErr },
  ] = await Promise.all([
    supabase
      .from("cost_codes")
      .select("id, code, name, position, is_active")
      .order("position", { ascending: true }),
    supabase
      .from("project_budget_lines")
      .select("cost_code_id, budget_amount, forecast_override")
      .eq("project_id", projectId),
    supabase
      .from("project_cost_actuals")
      .select("cost_code_id, amount, as_of, source")
      .eq("project_id", projectId),
    supabase
      .from("decisions")
      .select(
        `id, kind, cost_delta, markup_percent, allowance_amount,
         allowance_cost_code_id, selected_choice_id,
         decision_cost_items ( choice_id, cost_code_id, quantity, unit_cost )`
      )
      .eq("project_id", projectId)
      .eq("status", "approved"),
    supabase
      .from("purchase_orders")
      .select(
        "flat_fee, flat_total, po_line_items ( cost_code_id, quantity, unit_cost )"
      )
      .eq("project_id", projectId)
      .eq("status", "approved"),
  ])
  // A failed query must not render as "no budget" — fail loudly instead.
  const firstErr = ccErr ?? lErr ?? aErr ?? dErr ?? pErr
  if (firstErr) throw new Error(firstErr.message)

  const decisionsForBudget: DecisionForBudget[] = (decisions ?? []).map(
    (d) => ({
      id: d.id,
      kind: d.kind,
      cost_delta: d.cost_delta,
      markup_percent: d.markup_percent,
      allowance_amount: d.allowance_amount,
      allowance_cost_code_id: d.allowance_cost_code_id,
      selected_choice_id: d.selected_choice_id,
      cost_items: d.decision_cost_items ?? [],
    })
  )
  const posForBudget: PoForBudget[] = (pos ?? []).map((po) => ({
    flat_fee: po.flat_fee,
    flat_total: po.flat_total,
    line_items: po.po_line_items ?? [],
  }))

  const allCodes = costCodes ?? []
  const { rows, totals } = buildBudgetRows({
    costCodes: allCodes,
    lines: lines ?? [],
    actuals: actuals ?? [],
    decisions: decisionsForBudget,
    pos: posForBudget,
  })

  const usedIds = new Set(rows.map((r) => r.key))
  return (
    <BudgetClient
      projectId={projectId}
      projectName={project.name}
      projectNumber={project.project_number}
      canEdit={canEdit}
      rows={rows}
      totals={totals}
      // Active codes not yet on the table, for the "Add cost code" picker and
      // the import template.
      availableCodes={allCodes
        .filter((c) => c.is_active && !usedIds.has(c.id))
        .map((c) => ({ id: c.id, code: c.code, name: c.name }))}
      templateCodes={allCodes
        .filter((c) => c.is_active)
        .map((c) => ({ id: c.id, code: c.code, name: c.name }))}
    />
  )
}
