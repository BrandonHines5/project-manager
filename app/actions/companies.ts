"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const CompanyInput = z
  .object({
    id: optStr,
    name: z.string().min(1).max(200),
    type: z.enum(["sub", "vendor", "client"]),
    trade_category: optStr,
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

  const row = {
    name: parsed.name,
    type: parsed.type,
    trade_category: emptyToNull(parsed.trade_category),
    address: emptyToNull(parsed.address),
    phone: emptyToNull(parsed.phone),
    email: emptyToNull(parsed.email),
    notes: emptyToNull(parsed.notes),
  }

  if (parsed.id) {
    const { error } = await supabase
      .from("companies")
      .update(row)
      .eq("id", parsed.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from("companies").insert(row)
    if (error) throw new Error(error.message)
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
