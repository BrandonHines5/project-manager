"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"

const AssignInput = z.object({
  communication_id: z.string().min(1),
  project_id: z.string().min(1),
})

/**
 * Attach an unmatched (needs_review) communication to a project. Staff-only —
 * RLS backs this up (comms_staff_all is the only write policy).
 */
export async function assignCommunication(input: {
  communication_id: string
  project_id: string
}) {
  await requireStaff()
  const parsed = AssignInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("communications")
    .update({ project_id: parsed.project_id, status: "logged" })
    .eq("id", parsed.communication_id)
  if (error) throw new Error(error.message)
  revalidatePath("/communications")
  revalidatePath(`/projects/${parsed.project_id}/communications`)
}

/** Dismiss an unmatched communication (wrong number, spam, personal). */
export async function ignoreCommunication(input: { communication_id: string }) {
  await requireStaff()
  const id = z.string().min(1).parse(input.communication_id)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("communications")
    .update({ status: "ignored" })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/communications")
}

const SmsReplyInput = z.object({
  communication_id: z.string().min(1),
  body: z.string().min(1, "Write a message first.").max(1600),
})

/**
 * Text back from the Communications feed. The destination number is
 * re-resolved server-side from the logged row — the client never supplies a
 * raw phone number — and the send is logged with the same attribution so the
 * thread stays together.
 */
export async function sendSmsReply(input: {
  communication_id: string
  body: string
}): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireStaff()
  const parsed = SmsReplyInput.parse(input)
  const supabase = await createSupabaseServerClient()

  const { data: comm, error } = await supabase
    .from("communications")
    .select(
      "id, channel, direction, from_address, to_address, project_id, company_id, profile_id, counterparty_name"
    )
    .eq("id", parsed.communication_id)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!comm || comm.channel !== "sms") {
    return { ok: false, error: "Original text not found." }
  }
  const rawTo =
    comm.direction === "inbound" ? comm.from_address : comm.to_address
  const to = rawTo ? normalizeE164(rawTo) : null
  if (!to) return { ok: false, error: "No valid phone number on that thread." }

  const result = await sendQuoSms({
    to,
    content: parsed.body.trim(),
    log: {
      project_id: comm.project_id,
      company_id: comm.company_id,
      profile_id: comm.profile_id,
      sent_by: profile.id,
      kind: "hub_sms_reply",
      counterparty_name: comm.counterparty_name,
    },
  })
  if (!result.sent) {
    return { ok: false, error: result.reason ?? "Failed to send text." }
  }
  if (comm.project_id) {
    revalidatePath(`/projects/${comm.project_id}/communications`)
  }
  revalidatePath("/communications")
  return { ok: true }
}
