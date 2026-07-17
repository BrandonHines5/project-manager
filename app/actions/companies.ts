"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import type { TablesUpdate } from "@/lib/db/types"

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
    // "Also Known As" — name is the OFFICIAL name (payments, insurance);
    // aka is the everyday name that may appear on invoices/communication.
    aka: optStr,
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
    // Master-list fields (migration 0055). The RPC only knows the columns
    // above, so these are written in a follow-up update below.
    contact_name: optStr,
    phone_secondary: optStr,
    city: optStr,
    state: optStr,
    postal_code: optStr,
    website: optStr,
    status: optStr,
    // The sub's insurance agency/agent (ACORD "Producer"). Insurance
    // requests are CC'd to the agent email when present.
    insurance_agent_name: optStr,
    insurance_agent_email: optStr,
    insurance_agent_phone: optStr,
    // Per-company notification switch. Optional so a partial-update caller
    // can't silently flip it; the edit dialog always sends it.
    notifications_enabled: z.boolean().optional(),
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
  // The generated RPC arg types read plpgsql args as non-nullable, but the
  // function accepts (and the update path relies on) nulls — p_id null means
  // insert, null contact fields clear columns. Cast keeps regen-proof.
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
    } as unknown as Parameters<typeof supabase.rpc<"save_company_with_trades">>[1]
  )
  if (error) throw new Error(error.message)

  // The RPC handles the core columns + trades transactionally; the master-list
  // fields aren't part of its signature, so write them in a follow-up update
  // on the row the RPC just upserted (newId is the company id for both insert
  // and update paths). notifications_enabled is only written when explicitly
  // provided so a partial caller can't flip it by omission.
  const extra: TablesUpdate<"companies"> = {
    contact_name: emptyToNull(parsed.contact_name),
    phone_secondary: emptyToNull(parsed.phone_secondary),
    city: emptyToNull(parsed.city),
    state: emptyToNull(parsed.state),
    postal_code: emptyToNull(parsed.postal_code),
    website: emptyToNull(parsed.website),
    status: emptyToNull(parsed.status),
  }
  // Only written when explicitly provided (the edit dialog always sends
  // them): a partial-update caller omitting these mustn't wipe stored
  // values. An explicit null/"" still clears the field.
  if (parsed.aka !== undefined) {
    extra.aka = emptyToNull(parsed.aka)
  }
  if (parsed.insurance_agent_name !== undefined) {
    extra.insurance_agent_name = emptyToNull(parsed.insurance_agent_name)
  }
  if (parsed.insurance_agent_email !== undefined) {
    extra.insurance_agent_email = emptyToNull(parsed.insurance_agent_email)
  }
  if (parsed.insurance_agent_phone !== undefined) {
    extra.insurance_agent_phone = emptyToNull(parsed.insurance_agent_phone)
  }
  if (parsed.notifications_enabled !== undefined) {
    extra.notifications_enabled = parsed.notifications_enabled
  }
  const { error: extraErr } = await supabase
    .from("companies")
    .update(extra)
    .eq("id", newId)
  if (extraErr) throw new Error(extraErr.message)

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
