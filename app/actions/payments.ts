"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const PaymentInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    amount: z.coerce.number(),
    paid_on: z.string().min(1),
    method: z.enum(["check", "wire", "card", "cash", "other"]).default("check"),
    reference: optStr,
    notes: optStr,
  })
  .passthrough()

export type PaymentInputT = z.infer<typeof PaymentInput>

export async function savePayment(input: PaymentInputT) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const result = PaymentInput.safeParse(input)
  if (!result.success) {
    await supabase.from("debug_log").insert({
      tag: "savePayment:zod_error",
      payload: JSON.parse(JSON.stringify({ issues: result.error.issues, input })),
    })
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data

  if (parsed.id) {
    const { error } = await supabase
      .from("project_payments")
      .update({
        amount: parsed.amount,
        paid_on: parsed.paid_on,
        method: parsed.method,
        reference: parsed.reference ?? null,
        notes: parsed.notes ?? null,
      })
      .eq("id", parsed.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from("project_payments").insert({
      project_id: parsed.project_id,
      amount: parsed.amount,
      paid_on: parsed.paid_on,
      method: parsed.method,
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
      recorded_by: profile.id,
    })
    if (error) throw new Error(error.message)
  }
  revalidatePath(`/projects/${parsed.project_id}/pricing`)
}

export async function deletePayment({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("project_payments")
    .delete()
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/pricing`)
}
