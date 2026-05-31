"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendDashboardWebhook } from "@/lib/dashboard"

// Audit-log writes are no longer done here. Migration 0031 installed an
// AFTER INSERT OR UPDATE OR DELETE trigger on project_payments
// (`trg_record_payment_audit`) that writes payment_audit rows itself,
// captures the real actor via auth.uid(), and computes the action label
// (create / update / delete / restore) from the soft-delete column
// transitions. The previous RLS policy that let staff INSERT into
// payment_audit was dropped in the same migration, so this action can
// no longer fabricate an audit row even if it tried — and equally
// importantly, can no longer drop one on the floor.

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
    // Distinguish "row missing / RLS hides it" from "DB error" by reading
    // first and surfacing both with their own error message. The update
    // path also returns the row so the caller can confirm the write
    // actually landed.
    const { data: existing, error: readErr } = await supabase
      .from("project_payments")
      .select("id")
      .eq("id", parsed.id)
      .maybeSingle()
    if (readErr) throw new Error(readErr.message)
    if (!existing) throw new Error("Payment not found.")

    const patch = {
      amount: parsed.amount,
      paid_on: parsed.paid_on,
      method: parsed.method,
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
    }
    const { data: after, error: updErr } = await supabase
      .from("project_payments")
      .update(patch)
      .eq("id", parsed.id)
      .select("id")
      .maybeSingle()
    if (updErr) throw new Error(updErr.message)
    if (!after) {
      // Update returned no row even though the read found one — RLS
      // denied the write or someone soft-deleted between the two calls.
      throw new Error("Payment update was blocked.")
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
  void profile
  const supabase = await createSupabaseServerClient()
  const { data: before, error: readErr } = await supabase
    .from("project_payments")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!before) {
    // Treat missing as a 404 instead of silent success — the prior
    // version returned ok here, which could mask an authorisation bug
    // where the user couldn't see the row but called delete anyway.
    throw new Error("Payment not found.")
  }
  if (before.deleted_at) {
    // Already soft-deleted — idempotent no-op without re-stamping.
    return
  }
  // requireStaff() above already authorised this. The trigger captures
  // the actor + before/after via auth.uid() and the column delta.
  const { error } = await supabase
    .from("project_payments")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: profile.id,
    })
    .eq("id", id)
  if (error) throw new Error(error.message)
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
  void profile
  const supabase = await createSupabaseServerClient()
  const { data: before, error: readErr } = await supabase
    .from("project_payments")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!before) throw new Error("Payment not found.")
  if (!before.deleted_at) return
  const { error } = await supabase
    .from("project_payments")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/pricing`)
}
