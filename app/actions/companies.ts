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
    // Kept for back-compat callers; the canonical store is the
    // company_trades table. The save_company_with_trades RPC writes the
    // first trade into trade_category as a back-compat mirror.
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
  // Validate cap BEFORE any DB write (CodeRabbit #30): the previous
  // order placed this check after the company upsert, so a >20-trade
  // payload would write the company successfully and then fail, leaving
  // partial state.
  if (trades.length > 20) {
    throw new Error("At most 20 trades per company.")
  }

  const supabase = await createSupabaseServerClient()
  // Single transactional RPC (migration 0032). The function upserts the
  // companies row, deletes the prior trade set, and inserts the new one
  // — all under one transaction, so a failure on either DB step rolls
  // the whole call back. Replaces the previous three separate writes
  // which could leave the company without trades if the second write
  // failed.
  const { data: newId, error } = await supabase.rpc(
    "save_company_with_trades",
    {
      p_id: parsed.id ?? null,
      p_name: parsed.name,
      p_type: parsed.type,
      p_address: emptyToNull(parsed.address),
      p_phone: emptyToNull(parsed.phone),
      p_email: emptyToNull(parsed.email),
      p_notes: emptyToNull(parsed.notes),
      p_trades: trades,
    }
  )
  if (error) throw new Error(error.message)
  void newId

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
