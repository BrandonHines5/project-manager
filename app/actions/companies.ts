"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const CompanyInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  type: z.enum(["sub", "vendor", "client"]),
  trade_category: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  notes: z.string().nullable().optional(),
})

export type CompanyInputT = z.infer<typeof CompanyInput>

function emptyToNull(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

export async function saveCompany(input: CompanyInputT) {
  await requireStaff()
  const parsed = CompanyInput.parse(input)
  const supabase = await createSupabaseServerClient()

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

export async function deleteCompany(id: string) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("companies").delete().eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/companies")
}
