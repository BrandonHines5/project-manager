"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { parseSpreadsheet } from "@/lib/import/spreadsheet"

// Budget data is money-out (what we expect to pay), same sensitivity as
// committed costs — so beyond the staff-only RLS, every action here requires
// profiles.financial_access, like the Budget tab's POs column.
// RLS does not enforce financial_access anywhere (app-layer convention).
async function requireFinancialStaff() {
  const profile = await requireStaff()
  if (!profile.financial_access) {
    throw new Error("Financial access is required to edit budgets.")
  }
  return profile
}

// ---- Budget editors allowlist ---------------------------------------------
//
// Everyone with financial_access can READ the Budget tab; only the profiles
// on this allowlist (app_settings key 'budget_editors', picked in Settings →
// Budget editors) can MODIFY it. Semantics mirror invoice_payment_recipients:
//   * key never set → every financial_access staffer can edit (the pre-
//     allowlist behavior, so nothing breaks on deploy)
//   * explicit list → only those ids; only CURRENT editors may change the
//     list (an excluded staffer can't re-add themselves)
//   * explicit []  → read-only for everyone (any financial_access staffer
//     can reopen it in Settings, so there's no lockout)
//   * read failure / malformed row → fail closed to read-only, never open
// Same app-layer trust tier as financial_access itself — documented, not RLS.

const BUDGET_EDITORS_KEY = "budget_editors"
const editorIdsSchema = z.array(z.string().uuid()).max(50)

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>

/** Stored allowlist, or null when the key was never set (= everyone). */
async function loadBudgetEditorIds(
  supabase: SupabaseServer
): Promise<string[] | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", BUDGET_EDITORS_KEY)
    .maybeSingle()
  // Fail CLOSED on a read failure — a transient error must make budgets
  // read-only, never silently widen edit rights to everyone.
  if (error) {
    throw new Error(`Could not load the budget-editor list: ${error.message}`)
  }
  if (!data?.value) return null
  try {
    return editorIdsSchema.parse(JSON.parse(data.value))
  } catch {
    // Malformed settings row — fail closed (read-only for everyone). Any
    // financial_access staffer can re-save a valid list in Settings →
    // Budget editors, so this can't strand the org (see saveBudgetEditors).
    return []
  }
}

/**
 * Whether this profile may modify budgets. Page + actions share this.
 * ("use server" makes every export callable from the client, so it guards
 * itself even though the Budget page is the only intended caller.)
 */
export async function canEditBudget(profileId: string): Promise<boolean> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const ids = await loadBudgetEditorIds(supabase)
  return ids === null || ids.includes(profileId)
}

async function requireBudgetEditor() {
  const profile = await requireFinancialStaff()
  const supabase = await createSupabaseServerClient()
  const ids = await loadBudgetEditorIds(supabase)
  if (ids !== null && !ids.includes(profile.id)) {
    throw new Error(
      "Only budget editors can change the budget — it's read-only for you."
    )
  }
  return profile
}

export type BudgetEditorConfig = {
  staff: { id: string; full_name: string | null; financial_access: boolean }[]
  selected: string[]
  /** False when the key was never set (= everyone with financial access). */
  explicit: boolean
}

export async function getBudgetEditorConfig(): Promise<BudgetEditorConfig> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const [{ data: staff, error }, ids] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, financial_access")
      .eq("role", "staff")
      .order("full_name"),
    loadBudgetEditorIds(supabase),
  ])
  if (error) throw new Error(error.message)
  const staffRows = (staff ?? []).map((s) => ({
    id: s.id,
    full_name: s.full_name,
    financial_access: !!s.financial_access,
  }))
  return {
    staff: staffRows,
    // Unset key: pre-check the effective editors (financial_access staff) so
    // the picker shows today's reality; the first Save makes it explicit.
    selected:
      ids ?? staffRows.filter((s) => s.financial_access).map((s) => s.id),
    explicit: ids !== null,
  }
}

export async function saveBudgetEditors(ids: string[]) {
  const profile = await requireFinancialStaff()
  const parsed = editorIdsSchema.parse(ids)
  const supabase = await createSupabaseServerClient()
  // Allowlist administration is limited to CURRENT editors so an excluded
  // staffer can't quietly re-add themselves. Unset/empty/malformed lists
  // stay fixable by any financial_access staffer — no lockout state.
  const current = await loadBudgetEditorIds(supabase)
  if (current !== null && current.length > 0 && !current.includes(profile.id)) {
    throw new Error("Only current budget editors can change the editor list.")
  }
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: BUDGET_EDITORS_KEY,
      value: JSON.stringify(parsed),
      updated_by: profile.id,
    },
    { onConflict: "key" }
  )
  if (error) throw new Error(error.message)
  revalidatePath("/settings/budget")
}

const money = z.coerce.number().finite()

const BudgetLineInput = z.object({
  project_id: z.string().uuid(),
  cost_code_id: z.string().uuid(),
  budget_amount: money,
})

export async function saveBudgetLine(input: z.infer<typeof BudgetLineInput>) {
  const profile = await requireBudgetEditor()
  const parsed = BudgetLineInput.parse(input)
  const supabase = await createSupabaseServerClient()
  // Merge-upsert: only the provided columns are written, so setting the
  // budget never clobbers an existing forecast_override (and vice versa).
  const { error } = await supabase.from("project_budget_lines").upsert(
    {
      project_id: parsed.project_id,
      cost_code_id: parsed.cost_code_id,
      budget_amount: parsed.budget_amount,
      created_by: profile.id,
    },
    { onConflict: "project_id,cost_code_id" }
  )
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${parsed.project_id}/budget`)
}

const ForecastOverrideInput = z.object({
  project_id: z.string().uuid(),
  cost_code_id: z.string().uuid(),
  // null clears the override back to the default (New Budget − Actuals).
  forecast_override: money.nullable(),
})

export async function setForecastOverride(
  input: z.infer<typeof ForecastOverrideInput>
) {
  const profile = await requireBudgetEditor()
  const parsed = ForecastOverrideInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("project_budget_lines").upsert(
    {
      project_id: parsed.project_id,
      cost_code_id: parsed.cost_code_id,
      forecast_override: parsed.forecast_override,
      created_by: profile.id,
    },
    { onConflict: "project_id,cost_code_id" }
  )
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${parsed.project_id}/budget`)
}

export async function removeBudgetLine({
  project_id,
  cost_code_id,
}: {
  project_id: string
  cost_code_id: string
}) {
  await requireBudgetEditor()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("project_budget_lines")
    .delete()
    .eq("project_id", project_id)
    .eq("cost_code_id", cost_code_id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/budget`)
}

// ---- Spreadsheet import ----------------------------------------------------
//
// Two-step flow: parseBudgetImport reads the uploaded file and returns a
// preview (matched cost codes, amounts, anything skipped) without writing;
// applyBudgetImport then upserts the confirmed rows. Until QBO is live the
// optional "Actual costs" column lets interim actuals ride the same sheet.

export type BudgetImportRow = {
  cost_code_id: string
  code: string
  name: string
  budget_amount: number | null
  actual_amount: number | null
}

export type BudgetImportPreview = {
  rows: BudgetImportRow[]
  /** Rows whose cost code didn't match, with the reason. */
  skipped: { code: string; reason: string }[]
  hasActuals: boolean
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

function parseMoneyCell(raw: string): number | null | "invalid" {
  const s = raw.replace(/[$,\s]/g, "")
  if (s === "" || s === "—" || s === "-") return null
  // Accounting negatives: (1,234.56)
  const m = /^\((.*)\)$/.exec(s)
  const n = Number(m ? `-${m[1]}` : s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : "invalid"
}

// "10", "10.0" (numeric cell), or a "10 — Permits" style label all resolve to
// the bare code the cost_codes table stores.
function normalizeCode(raw: string): string {
  const first = raw.trim().split(/[\s—–-]/)[0] ?? ""
  return first.replace(/\.0+$/, "")
}

export async function parseBudgetImport(
  formData: FormData
): Promise<BudgetImportPreview> {
  await requireBudgetEditor()
  const file = formData.get("file")
  if (!(file instanceof File)) throw new Error("No file uploaded.")
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error("File is too large (5 MB max).")
  }

  let grid: string[][]
  try {
    grid = parseSpreadsheet(file.name, Buffer.from(await file.arrayBuffer()))
  } catch (e) {
    throw new Error(
      `Couldn't read that file: ${e instanceof Error ? e.message : "unknown error"}. Upload the .xlsx template or a .csv.`
    )
  }

  // Header row = the first row mentioning a cost-code column. Everything
  // above it (titles, blank rows) is ignored.
  const headerIdx = grid.findIndex((row) =>
    row.some((c) => /cost\s*code|^code$/i.test(c.trim()))
  )
  if (headerIdx < 0) {
    throw new Error(
      'No header row found — the sheet needs a "Cost code" column. Download the template for the expected layout.'
    )
  }
  const header = grid[headerIdx].map((c) => c.trim().toLowerCase())
  const codeCol = header.findIndex((c) => /cost\s*code|^code$/.test(c))
  const budgetCol = header.findIndex((c) => /^budget/.test(c))
  const actualCol = header.findIndex((c) => /actual/.test(c))
  if (budgetCol < 0 && actualCol < 0) {
    throw new Error(
      'No amount column found — the sheet needs a "Budget" (and/or "Actual costs") column.'
    )
  }

  const supabase = await createSupabaseServerClient()
  const { data: codes, error } = await supabase
    .from("cost_codes")
    .select("id, code, name")
  if (error) throw new Error(error.message)
  const byCode = new Map((codes ?? []).map((c) => [c.code, c]))

  const rows: BudgetImportRow[] = []
  const skipped: BudgetImportPreview["skipped"] = []
  const seen = new Set<string>()
  for (const row of grid.slice(headerIdx + 1)) {
    const rawCode = (row[codeCol] ?? "").trim()
    if (!rawCode) continue // blank spacer rows
    const code = normalizeCode(rawCode)
    const cc = byCode.get(code)
    if (!cc) {
      skipped.push({ code: rawCode, reason: "No matching cost code" })
      continue
    }
    if (seen.has(cc.id)) {
      skipped.push({ code: rawCode, reason: "Duplicate row (first one wins)" })
      continue
    }
    const budget = budgetCol >= 0 ? parseMoneyCell(row[budgetCol] ?? "") : null
    const actual = actualCol >= 0 ? parseMoneyCell(row[actualCol] ?? "") : null
    if (budget === "invalid" || actual === "invalid") {
      skipped.push({ code: rawCode, reason: "Amount isn't a number" })
      continue
    }
    if (budget == null && actual == null) continue // nothing to import
    seen.add(cc.id)
    rows.push({
      cost_code_id: cc.id,
      code: cc.code,
      name: cc.name,
      budget_amount: budget,
      actual_amount: actual,
    })
  }

  return {
    rows,
    skipped,
    hasActuals: rows.some((r) => r.actual_amount != null),
  }
}

const ApplyImportInput = z.object({
  project_id: z.string().uuid(),
  rows: z
    .array(
      z.object({
        cost_code_id: z.string().uuid(),
        budget_amount: money.nullable(),
        actual_amount: money.nullable(),
      })
    )
    .min(1)
    .max(500),
})

export async function applyBudgetImport(
  input: z.infer<typeof ApplyImportInput>
) {
  const profile = await requireBudgetEditor()
  const parsed = ApplyImportInput.parse(input)
  const supabase = await createSupabaseServerClient()

  const budgetRows = parsed.rows.filter((r) => r.budget_amount != null)
  if (budgetRows.length > 0) {
    const { error } = await supabase.from("project_budget_lines").upsert(
      budgetRows.map((r) => ({
        project_id: parsed.project_id,
        cost_code_id: r.cost_code_id,
        budget_amount: r.budget_amount!,
        created_by: profile.id,
      })),
      { onConflict: "project_id,cost_code_id" }
    )
    if (error) throw new Error(error.message)
  }

  const actualRows = parsed.rows.filter((r) => r.actual_amount != null)
  if (actualRows.length > 0) {
    const { error } = await supabase.from("project_cost_actuals").upsert(
      actualRows.map((r) => ({
        project_id: parsed.project_id,
        cost_code_id: r.cost_code_id,
        amount: r.actual_amount!,
        source: "import",
        as_of: new Date().toISOString().slice(0, 10),
      })),
      { onConflict: "project_id,cost_code_id" }
    )
    if (error) throw new Error(error.message)
  }

  revalidatePath(`/projects/${parsed.project_id}/budget`)
  return { budgets: budgetRows.length, actuals: actualRows.length }
}
