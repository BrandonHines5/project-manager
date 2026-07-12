"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { sendEmail } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"

const AssignInput = z.object({
  communication_id: z.string().min(1),
  project_id: z.string().min(1),
})

/**
 * Optionally file a communication to a project from the global hub. Nothing
 * requires this — unfiled calls/texts just live in the searchable global log —
 * but staff can attach one to a job when it's worth keeping on that record.
 * Staff-only; RLS backs this up (comms_staff_all is the only write policy).
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

/** Dismiss a communication (wrong number, spam, personal) — hides it from the hub. */
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

const ComposeRecipient = z.discriminatedUnion("kind", [
  // Known contacts resolve their address server-side — the browser only
  // names WHO, never supplies the number/email for them.
  z.object({ kind: z.literal("company"), company_id: z.string().min(1) }),
  z.object({
    kind: z.literal("project_client"),
    project_id: z.string().min(1),
    slot: z.union([z.literal(1), z.literal(2)]),
  }),
  // Deliberate one-off entry (a number/address not on file anywhere).
  z.object({
    kind: z.literal("custom"),
    name: z.string().max(200).nullish(),
    address: z.string().min(1).max(320),
  }),
])

const ComposeInput = z
  .object({
    channel: z.enum(["sms", "email"]),
    /** Job the message is filed to (compose from a project tab). Null = global. */
    project_id: z.string().min(1).nullish(),
    recipient: ComposeRecipient,
    subject: z.string().max(200).nullish(),
    body: z.string().min(1, "Write a message first.").max(10_000),
  })
  .superRefine((v, ctx) => {
    if (v.channel === "email" && !v.subject?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: "Subject is required for an email.",
      })
    }
    if (v.channel === "sms" && v.body.length > 1600) {
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "Texts are limited to 1600 characters.",
      })
    }
  })

/**
 * Start a NEW conversation from the Communications tab — a text (via the
 * staffer's own Quo number, same routing as every other outbound SMS) or an
 * email (Outlook/Resend via sendEmail). The send is logged to `communications`
 * (kind manual_sms / manual_email) so it appears in the feed it was composed
 * from, attributed to the company / client / project like inbound traffic.
 */
export async function composeMessage(input: {
  channel: "sms" | "email"
  project_id?: string | null
  recipient:
    | { kind: "company"; company_id: string }
    | { kind: "project_client"; project_id: string; slot: 1 | 2 }
    | { kind: "custom"; name?: string | null; address: string }
  subject?: string | null
  body: string
}): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireStaff()
  const parsed = ComposeInput.parse(input)
  const supabase = await createSupabaseServerClient()

  // Resolve the destination + feed attribution from the recipient.
  let to: string
  let counterpartyName: string | null = null
  let companyId: string | null = null
  let profileId: string | null = null
  let projectId = parsed.project_id ?? null

  const rec = parsed.recipient
  if (rec.kind === "company") {
    const { data: company, error } = await supabase
      .from("companies")
      .select("id, name, email, phone, phone_secondary")
      .eq("id", rec.company_id)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!company) return { ok: false, error: "Company not found." }
    companyId = company.id
    counterpartyName = company.name
    if (parsed.channel === "sms") {
      const phone = company.phone || company.phone_secondary
      if (!phone) {
        return { ok: false, error: `${company.name} has no phone number on file.` }
      }
      const normalized = normalizeE164(phone)
      if (!normalized) {
        return {
          ok: false,
          error: `${company.name}'s phone number (${phone}) isn't a valid US number.`,
        }
      }
      to = normalized
    } else {
      if (!company.email) {
        return { ok: false, error: `${company.name} has no email on file.` }
      }
      to = company.email
    }
  } else if (rec.kind === "project_client") {
    const { data: project, error } = await supabase
      .from("projects")
      .select(
        "id, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2"
      )
      .eq("id", rec.project_id)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!project) return { ok: false, error: "Project not found." }
    const name = rec.slot === 1 ? project.client_name : project.client_name_2
    const email = rec.slot === 1 ? project.client_email : project.client_email_2
    const phone = rec.slot === 1 ? project.client_phone : project.client_phone_2
    counterpartyName = name || "Client"
    // A message to the job's client always files to that job.
    projectId = project.id
    if (parsed.channel === "sms") {
      if (!phone) {
        return { ok: false, error: "No client phone number on this job." }
      }
      const normalized = normalizeE164(phone)
      if (!normalized) {
        return {
          ok: false,
          error: `The client's phone number (${phone}) isn't a valid US number.`,
        }
      }
      to = normalized
    } else {
      if (!email) return { ok: false, error: "No client email on this job." }
      to = email
    }
    // Best-effort: when the client has a portal login on this job, stamp
    // their profile so the message shows up in THEIR portal feed too
    // (comms_client_read needs profile_id + project_id).
    profileId = await matchClientProfile(project.id, to, parsed.channel)
  } else {
    counterpartyName = rec.name?.trim() || null
    if (parsed.channel === "sms") {
      const normalized = normalizeE164(rec.address)
      if (!normalized) {
        return {
          ok: false,
          error: `"${rec.address}" isn't a valid US phone number.`,
        }
      }
      to = normalized
    } else {
      const email = z.string().email().safeParse(rec.address.trim())
      if (!email.success) {
        return { ok: false, error: `"${rec.address}" isn't a valid email address.` }
      }
      to = email.data
    }
  }

  const log = {
    project_id: projectId,
    company_id: companyId,
    profile_id: profileId,
    sent_by: profile.id,
    kind: parsed.channel === "sms" ? "manual_sms" : "manual_email",
    counterparty_name: counterpartyName,
  }

  if (parsed.channel === "sms") {
    const result = await sendQuoSms({ to, content: parsed.body.trim(), log })
    if (!result.sent) {
      return { ok: false, error: result.reason ?? "Failed to send text." }
    }
  } else {
    const result = await sendEmail({
      to,
      subject: parsed.subject!.trim(),
      text: parsed.body.trim(),
      log,
    })
    if (!result.sent) {
      return { ok: false, error: result.reason ?? "Failed to send email." }
    }
  }

  if (projectId) revalidatePath(`/projects/${projectId}/communications`)
  revalidatePath("/communications")
  return { ok: true }
}

/**
 * The client-portal profile behind a project's client contact, if exactly one
 * client member of the job matches the address we're sending to. Best-effort:
 * any miss or ambiguity returns null and the send just logs without a
 * profile link (staff still see it; the client portal won't).
 */
async function matchClientProfile(
  projectId: string,
  address: string,
  channel: "sms" | "email"
): Promise<string | null> {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return null
    const { data, error } = await admin
      .from("project_members")
      .select("profile_id, profiles!inner(id, email, phone, role)")
      .eq("project_id", projectId)
    if (error || !data) return null
    const last10 = (p: string) => p.replace(/\D/g, "").slice(-10)
    const matches = data.filter((m) => {
      const p = (m as unknown as {
        profiles: { email: string | null; phone: string | null; role: string }
      }).profiles
      if (!p || p.role !== "client") return false
      return channel === "email"
        ? (p.email ?? "").toLowerCase() === address.toLowerCase()
        : Boolean(p.phone) && last10(p.phone!) === last10(address)
    })
    return matches.length === 1 ? matches[0].profile_id : null
  } catch {
    return null
  }
}
