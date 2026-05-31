"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendDashboardWebhook } from "@/lib/dashboard"

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
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data

  if (parsed.id) {
    const { data: before } = await supabase
      .from("project_payments")
      .select("*")
      .eq("id", parsed.id)
      .maybeSingle()
    const patch = {
      amount: parsed.amount,
      paid_on: parsed.paid_on,
      method: parsed.method,
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
    }
    const { data: after, error } = await supabase
      .from("project_payments")
      .update(patch)
      .eq("id", parsed.id)
      .select("*")
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (after) {
      await supabase.from("payment_audit").insert({
        payment_id: parsed.id,
        action: "update",
        actor_id: profile.id,
        before: before ?? null,
        after,
      })
    }
  } else {
    const { data: row, error } = await supabase
      .from("project_payments")
      .insert({
        project_id: parsed.project_id,
        amount: parsed.amount,
        paid_on: parsed.paid_on,
        method: parsed.method,
        reference: parsed.reference ?? null,
        notes: parsed.notes ?? null,
        recorded_by: profile.id,
      })
      .select("*")
      .single()
    if (error) throw new Error(error.message)
    if (row) {
      await supabase.from("payment_audit").insert({
        payment_id: row.id,
        action: "create",
        actor_id: profile.id,
        before: null,
        after: row,
      })
      await sendDashboardWebhook("payment.recorded", row)
    }
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
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: before } = await supabase
    .from("project_payments")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (!before) {
    // Already gone (or RLS-invisible). Treat as success — idempotent delete.
    return
  }
  if (before.deleted_at) {
    // Already soft-deleted; do nothing rather than re-stamp.
    return
  }
  const { error } = await supabase
    .from("project_payments")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: profile.id,
    })
    .eq("id", id)
  if (error) throw new Error(error.message)
  await supabase.from("payment_audit").insert({
    payment_id: id,
    action: "delete",
    actor_id: profile.id,
    before,
    after: null,
  })
  revalidatePath(`/projects/${project_id}/pricing`)
}

export async function restorePayment({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: before } = await supabase
    .from("project_payments")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (!before || !before.deleted_at) return
  const { data: after, error } = await supabase
    .from("project_payments")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", id)
    .select("*")
    .maybeSingle()
  if (error) throw new Error(error.message)
  await supabase.from("payment_audit").insert({
    payment_id: id,
    action: "restore",
    actor_id: profile.id,
    before,
    after: after ?? null,
  })
  revalidatePath(`/projects/${project_id}/pricing`)
}
