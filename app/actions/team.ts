"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const UpdateProfileInput = z.object({
  id: z.string().uuid(),
  full_name: z.string().min(1).max(200),
  role: z.enum(["staff", "trade", "client"]),
  company_id: z.string().uuid().nullable().optional(),
  phone: z.string().nullable().optional(),
})

export type UpdateProfileInputT = z.infer<typeof UpdateProfileInput>

export async function updateProfile(input: UpdateProfileInputT) {
  await requireStaff()
  const parsed = UpdateProfileInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.full_name,
      role: parsed.role,
      company_id: parsed.company_id ?? null,
      phone: parsed.phone ?? null,
    })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath("/team")
}
