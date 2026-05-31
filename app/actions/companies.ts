"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

// Trades are free-text but normalized: lower-cased, trimmed, 1..60 chars.
// Matches the CHECK constraint on company_trades.trade so a bad client
// payload fails at the action layer with a useful error instead of a
// generic DB constraint message.
const Trade = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.length >= 1 && s.length <= 60, {
    message: "Each trade must be 1–60 characters",
  })

const CompanyInput = z
  .object({
    id: optStr,
    name: z.string().min(1).max(200),
    type: z.enum(["sub", "vendor", "client"]),
    // Kept for back-compat; the canonical store is the company_trades table.
    // We also write the first trade into trade_category so anything still
    // reading that column shows a sensible value.
    trade_category: optStr,
    trades: z.array(Trade).default([]),
    address: optStr,
    phone: optStr,
    email: optStr,
    notes: optStr,
  })
  .passthrough()

export type CompanyInputT = z.infer<typeof CompanyInput>

function emptyToNull(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

export async function saveCompany(input: CompanyInputT) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const result = CompanyInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data

  // Dedupe + sort trades so the order in the junction is stable. Trade was
  // already trimmed+lower-cased by the zod transform above.
  const trades = Array.from(new Set(parsed.trades)).sort()

  const row = {
    name: parsed.name,
    type: parsed.type,
    // trade_category mirrors the first trade for legacy readers; the source
    // of truth is the junction table now.
    trade_category:
      trades.length > 0 ? trades[0] : emptyToNull(parsed.trade_category),
    address: emptyToNull(parsed.address),
    phone: emptyToNull(parsed.phone),
    email: emptyToNull(parsed.email),
    notes: emptyToNull(parsed.notes),
  }

  let companyId = parsed.id
  if (companyId) {
    const { error } = await supabase
      .from("companies")
      .update(row)
      .eq("id", companyId)
    if (error) throw new Error(error.message)
  } else {
    const { data: inserted, error } = await supabase
      .from("companies")
      .insert(row)
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    companyId = inserted.id
  }

  // Replace the trade set. Simpler than diffing and avoids the case where the
  // junction grew stale because of a server-side migration mismatch. Cap at
  // 20 trades so a bad client can't bloat the row.
  if (trades.length > 20) {
    throw new Error("At most 20 trades per company.")
  }
  const { error: delErr } = await supabase
    .from("company_trades")
    .delete()
    .eq("company_id", companyId)
  if (delErr) throw new Error(delErr.message)
  if (trades.length > 0) {
    const { error: insErr } = await supabase
      .from("company_trades")
      .insert(trades.map((t) => ({ company_id: companyId!, trade: t })))
    if (insErr) throw new Error(insErr.message)
  }

  revalidatePath("/companies")
}

const DeleteCompanyInput = z.object({ id: z.string() })

export async function deleteCompany(id: string) {
  await requireStaff()
  const parsed = DeleteCompanyInput.parse({ id })
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("companies")
    .delete()
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath("/companies")
}
