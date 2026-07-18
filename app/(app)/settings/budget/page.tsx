import { requireStaff } from "@/lib/auth"
import { getBudgetEditorConfig } from "@/app/actions/budget"
import { BudgetEditorsClient } from "./budget-editors-client"

export const metadata = { title: "Budget editors — BuildFox" }

/**
 * Staff-only picker for WHO may modify project budgets (app_settings key
 * 'budget_editors'). Everyone with financial access keeps read access; the
 * people checked here are the only ones who can change budget lines,
 * forecast overrides, and imports.
 */
export default async function BudgetEditorsPage() {
  await requireStaff()
  const config = await getBudgetEditorConfig()
  return <BudgetEditorsClient config={config} />
}
