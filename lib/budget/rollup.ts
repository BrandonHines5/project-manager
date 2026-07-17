// Pure math for the per-project Budget tab. Everything here is derived from
// four inputs — budget lines, approved decisions (+ their cost items),
// approved-PO line items, and actual costs — and rolled up per cost code:
//
//   Budget               staff-entered project_budget_lines.budget_amount
//   Changes to Budget    approved selections & change orders, allocated to the
//                        cost codes on their line items (see allocation notes)
//   New Budget           Budget + Changes
//   Actual Costs to Date project_cost_actuals (QBO once live; import today)
//   Purchase Orders      approved-PO committed costs (the app's only
//                        committed-costs rollup — Pricing doesn't show one)
//   Forecasted Remaining forecast_override ?? (New Budget − Actuals)
//   Total Forecasted     Actuals + Forecasted Remaining
//   Variance             Total Forecasted − New Budget (positive = over)
//
// Kept UI-free so the allocation rules can be exercised without a browser.

export const UNCODED_KEY = "__uncoded__"

export type BudgetCostCode = {
  id: string
  code: string
  name: string
  position: number
}

export type BudgetLineInput = {
  cost_code_id: string
  budget_amount: number
  forecast_override: number | null
}

export type ActualCostInput = {
  cost_code_id: string
  amount: number
  as_of: string | null
  source: string
}

export type DecisionForBudget = {
  id: string
  kind: "change_order" | "selection"
  cost_delta: number | null
  markup_percent: number | null
  allowance_amount: number | null
  allowance_cost_code_id: string | null
  selected_choice_id: string | null
  cost_items: {
    choice_id: string | null
    cost_code_id: string | null
    quantity: number
    unit_cost: number
  }[]
}

export type PoForBudget = {
  flat_fee: boolean
  flat_total: number | null
  line_items: {
    cost_code_id: string | null
    quantity: number
    unit_cost: number
  }[]
}

export type BudgetRow = {
  /** cost_code_id, or UNCODED_KEY for the flat-fee/uncoded bucket. */
  key: string
  code: string | null
  label: string
  hasLine: boolean
  budget: number
  changes: number
  newBudget: number
  actuals: number
  actualsAsOf: string | null
  pos: number
  forecastOverride: number | null
  forecastRemaining: number
  totalForecast: number
  variance: number
}

export type BudgetTotals = Pick<
  BudgetRow,
  | "budget"
  | "changes"
  | "newBudget"
  | "actuals"
  | "pos"
  | "forecastRemaining"
  | "totalForecast"
  | "variance"
>

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Allocates each approved decision's cost_delta across cost codes. The line
 * items carry the codes: change orders use their direct items, selections use
 * the chosen choice's items, both marked up by the decision's markup_percent
 * (mirroring saveDecision's math). An allowance credits its own cost code.
 * Whatever the items don't account for — delay cost, a manual cost_delta,
 * rounding — lands in the uncoded bucket, so the column's grand total always
 * equals the Pricing tab's "Approved changes" sum exactly.
 */
export function allocateDecisionChanges(
  decisions: DecisionForBudget[]
): Map<string, number> {
  const byCode = new Map<string, number>()
  const add = (key: string, amount: number) => {
    if (amount === 0) return
    byCode.set(key, round2((byCode.get(key) ?? 0) + amount))
  }

  for (const d of decisions) {
    const mul = 1 + (Number(d.markup_percent) || 0) / 100
    const items =
      d.kind === "selection"
        ? d.cost_items.filter(
            (ci) => ci.choice_id && ci.choice_id === d.selected_choice_id
          )
        : d.cost_items.filter((ci) => !ci.choice_id)

    let allocated = 0
    for (const ci of items) {
      const amount = round2(ci.quantity * ci.unit_cost * mul)
      add(ci.cost_code_id ?? UNCODED_KEY, amount)
      allocated = round2(allocated + amount)
    }

    if (d.kind === "selection" && d.allowance_amount != null) {
      const credit = -Number(d.allowance_amount)
      add(d.allowance_cost_code_id ?? UNCODED_KEY, credit)
      allocated = round2(allocated + credit)
    }

    // Item-less decisions (manual cost_delta) fall entirely into the
    // remainder; point an allowance selection's remainder at its allowance
    // code so single-code allowances land where they belong.
    const remainder = round2((Number(d.cost_delta) || 0) - allocated)
    if (remainder !== 0) {
      const key =
        items.length === 0 && d.allowance_cost_code_id
          ? d.allowance_cost_code_id
          : UNCODED_KEY
      add(key, remainder)
    }
  }
  return byCode
}

/** Approved-PO committed costs per cost code; flat-fee POs bucket as uncoded. */
export function allocatePoCommitments(pos: PoForBudget[]): Map<string, number> {
  const byCode = new Map<string, number>()
  const add = (key: string, amount: number) => {
    if (amount === 0) return
    byCode.set(key, round2((byCode.get(key) ?? 0) + amount))
  }
  for (const po of pos) {
    if (po.flat_fee) {
      add(UNCODED_KEY, round2(Number(po.flat_total ?? 0)))
      continue
    }
    for (const li of po.line_items) {
      add(li.cost_code_id ?? UNCODED_KEY, round2(li.quantity * li.unit_cost))
    }
  }
  return byCode
}

export function buildBudgetRows(input: {
  costCodes: BudgetCostCode[]
  lines: BudgetLineInput[]
  actuals: ActualCostInput[]
  decisions: DecisionForBudget[]
  pos: PoForBudget[]
}): { rows: BudgetRow[]; totals: BudgetTotals } {
  const codeById = new Map(input.costCodes.map((c) => [c.id, c]))
  const lineByCode = new Map(input.lines.map((l) => [l.cost_code_id, l]))
  const actualByCode = new Map(input.actuals.map((a) => [a.cost_code_id, a]))
  const changesByCode = allocateDecisionChanges(input.decisions)
  const posByCode = allocatePoCommitments(input.pos)

  // A row exists for every code that has any data on it. A code the cost-code
  // list no longer knows (deactivated after budgeting) still renders by id.
  const keys = new Set<string>([
    ...lineByCode.keys(),
    ...actualByCode.keys(),
    ...changesByCode.keys(),
    ...posByCode.keys(),
  ])

  const rows: BudgetRow[] = [...keys].map((key) => {
    const cc = key === UNCODED_KEY ? null : codeById.get(key)
    const line = lineByCode.get(key)
    const actual = actualByCode.get(key)

    const budget = round2(Number(line?.budget_amount ?? 0))
    const changes = changesByCode.get(key) ?? 0
    const newBudget = round2(budget + changes)
    const actuals = round2(Number(actual?.amount ?? 0))
    const pos = posByCode.get(key) ?? 0
    const forecastOverride =
      line?.forecast_override != null ? Number(line.forecast_override) : null
    const forecastRemaining =
      forecastOverride ?? round2(newBudget - actuals)
    const totalForecast = round2(actuals + forecastRemaining)
    const variance = round2(totalForecast - newBudget)

    return {
      key,
      code: cc?.code ?? null,
      label:
        key === UNCODED_KEY
          ? "Uncoded / flat fee"
          : cc
            ? `${cc.code} — ${cc.name}`
            : "Unknown cost code",
      hasLine: !!line,
      budget,
      changes,
      newBudget,
      actuals,
      actualsAsOf: actual?.as_of ?? null,
      pos,
      forecastOverride,
      forecastRemaining,
      totalForecast,
      variance,
    }
  })

  // Canonical cost-code order (position, the same order the pickers use),
  // with the uncoded bucket pinned to the bottom.
  rows.sort((a, b) => {
    if (a.key === UNCODED_KEY) return 1
    if (b.key === UNCODED_KEY) return -1
    const pa = codeById.get(a.key)?.position ?? Number.MAX_SAFE_INTEGER
    const pb = codeById.get(b.key)?.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return a.label.localeCompare(b.label, undefined, { numeric: true })
  })

  const totals = rows.reduce<BudgetTotals>(
    (t, r) => ({
      budget: round2(t.budget + r.budget),
      changes: round2(t.changes + r.changes),
      newBudget: round2(t.newBudget + r.newBudget),
      actuals: round2(t.actuals + r.actuals),
      pos: round2(t.pos + r.pos),
      forecastRemaining: round2(t.forecastRemaining + r.forecastRemaining),
      totalForecast: round2(t.totalForecast + r.totalForecast),
      variance: round2(t.variance + r.variance),
    }),
    {
      budget: 0,
      changes: 0,
      newBudget: 0,
      actuals: 0,
      pos: 0,
      forecastRemaining: 0,
      totalForecast: 0,
      variance: 0,
    }
  )

  return { rows, totals }
}
