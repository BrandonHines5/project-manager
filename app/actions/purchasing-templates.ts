"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getActiveOrgId } from "@/lib/org"
import type { Json } from "@/lib/db/types"

const optStr = z.string().nullish()

// One template line. unit_cost is nullable on purpose: a template saved from
// a bid package has no pricing (subs price bids); instantiating a template as
// a bid DROPS unit_cost, as a PO defaults missing unit_cost to 0.
const TemplateLine = z.object({
  cost_code_id: optStr,
  description: z.string().min(1),
  quantity: z.coerce.number().default(1),
  unit: optStr,
  unit_cost: z.coerce.number().nullish(),
})

const TemplateInput = z.object({
  id: optStr,
  // trim() before min(1) so whitespace-only names/titles are rejected.
  name: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  scope: optStr,
  flat_fee: z.boolean().default(false),
  line_items: z.array(TemplateLine).default([]),
  // Not part of the template (templates are org-wide) — identifies the
  // purchasing page the caller is on so its template list revalidates.
  project_id: optStr,
})

export type PurchasingTemplateInputT = z.infer<typeof TemplateInput>

export type PurchasingTemplateLine = z.infer<typeof TemplateLine>

export type PurchasingTemplateRow = {
  id: string
  name: string
  title: string
  scope: string | null
  flat_fee: boolean
  line_items: PurchasingTemplateLine[]
}

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

/**
 * Org-wide purchasing templates (0095) — usable as EITHER a bid request or a
 * purchase order. Save overwrites by id; new templates insert.
 */
export async function savePurchasingTemplate(input: PurchasingTemplateInputT) {
  const profile = await requireStaff()
  const result = TemplateInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid template at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  const row = {
    name: parsed.name.trim(),
    title: parsed.title,
    scope: nz(parsed.scope),
    flat_fee: parsed.flat_fee,
    line_items: parsed.line_items.map((li) => ({
      cost_code_id: nz(li.cost_code_id),
      description: li.description,
      quantity: li.quantity,
      unit: nz(li.unit),
      unit_cost: li.unit_cost ?? null,
    })) as unknown as Json,
  }

  const id = nz(parsed.id)
  if (id) {
    const { error, count } = await supabase
      .from("purchasing_templates")
      .update(row, { count: "exact" })
      .eq("id", id)
    if (error) throw new Error(error.message)
    if (!count) throw new Error("Template not found")
    revalidateTemplateConsumers(parsed.project_id)
    return { id }
  }
  const { data, error } = await supabase
    .from("purchasing_templates")
    .insert({ ...row, org_id: await getActiveOrgId(supabase), created_by: profile.id })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidateTemplateConsumers(parsed.project_id)
  return { id: data.id }
}

export async function deletePurchasingTemplate(id: string, projectId?: string) {
  await requireStaff()
  const parsed = z.string().uuid().parse(id)
  const parsedProjectId = z.string().uuid().optional().parse(projectId)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("purchasing_templates")
    .delete()
    .eq("id", parsed)
  if (error) throw new Error(error.message)
  revalidateTemplateConsumers(parsedProjectId)
}

// Templates are org-wide, so there's no single page to invalidate — the
// caller passes the project it's on. Other projects' purchasing pages pick
// up the change on their own next render (dynamic pages, no full-route
// cache dependency on this data).
function revalidateTemplateConsumers(projectId: string | null | undefined) {
  if (projectId) revalidatePath(`/projects/${projectId}/purchasing`)
}

/**
 * Templates for the create flows. A template with ANY malformed line_items
 * entry (hand-edited row, older shape) is excluded wholesale — offering it
 * with lines silently missing could produce an incomplete bid/PO that looks
 * complete. The row stays in the DB for repair; it just isn't offered.
 */
export async function listPurchasingTemplates(): Promise<PurchasingTemplateRow[]> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("purchasing_templates")
    .select("id, name, title, scope, flat_fee, line_items")
    .order("name", { ascending: true })
  if (error) throw new Error(error.message)
  const out: PurchasingTemplateRow[] = []
  for (const t of data ?? []) {
    const rawLines = Array.isArray(t.line_items) ? t.line_items : []
    const lines: PurchasingTemplateLine[] = []
    let malformed = !Array.isArray(t.line_items) && t.line_items !== null
    for (const raw of rawLines) {
      const parsed = TemplateLine.safeParse(raw)
      if (parsed.success) lines.push(parsed.data)
      else malformed = true
    }
    if (malformed) {
      console.warn(
        `[purchasing-templates] template ${t.id} ("${t.name}") has malformed line_items — excluded from pickers`
      )
      continue
    }
    out.push({
      id: t.id,
      name: t.name,
      title: t.title,
      scope: t.scope,
      flat_fee: t.flat_fee,
      line_items: lines,
    })
  }
  return out
}
