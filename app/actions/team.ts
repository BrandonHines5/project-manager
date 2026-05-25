"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const UpdateProfileInput = z
  .object({
    id: z.string(),
    full_name: z.string().min(1).max(200),
    role: z.enum(["staff", "trade", "client"]),
    company_id: optStr,
    phone: optStr,
  })
  .passthrough()

export type UpdateProfileInputT = z.infer<typeof UpdateProfileInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

export async function updateProfile(input: UpdateProfileInputT) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const result = UpdateProfileInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.full_name,
      role: parsed.role,
      company_id: nz(parsed.company_id),
      phone: nz(parsed.phone),
    })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath("/team")
}
