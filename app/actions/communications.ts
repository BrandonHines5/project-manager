"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireSession, requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getActiveOrgId } from "@/lib/org"
import { appUrl, sendEmail } from "@/lib/email"
import { mutedProfileIdsForProject } from "@/lib/notifications/preferences"
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
  // meta.job_match='manual' marks a human filing decision — the outlook-sync
  // AI sweep only touches rows with no job_match, so a staff filing (or
  // re-filing) is final. Read-merge because a jsonb update replaces the
  // whole column.
  const { data: existing } = await supabase
    .from("communications")
    .select("meta")
    .eq("id", parsed.communication_id)
    .maybeSingle()
  const meta = {
    ...((existing?.meta ?? {}) as Record<string, unknown>),
    job_match: "manual",
  }
  const { error } = await supabase
    .from("communications")
    .update({ project_id: parsed.project_id, status: "logged", meta })
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
      "id, org_id, channel, direction, from_address, to_address, project_id, company_id, profile_id, counterparty_name"
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
      // The reply belongs to the same org as the thread it answers (the
      // RLS-scoped read above guarantees that's also the caller's org).
      org_id: comm.org_id,
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
  const validated = ComposeInput.safeParse(input)
  if (!validated.success) {
    return {
      ok: false,
      error: validated.error.issues[0]?.message ?? "Invalid input.",
    }
  }
  const parsed = validated.data
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
    // Stamp the acting staffer's org — the one place a custom-recipient send
    // (no company/project to resolve through) can learn its org.
    org_id: await getActiveOrgId(supabase),
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

const ClientComposeInput = z.object({
  project_id: z.string().uuid(),
  subject: z.string().max(200).nullish(),
  body: z.string().min(1, "Write a message first.").max(10_000),
})

/**
 * A client starts a message to the team from their project's Communications
 * tab. No recipient picker — it always goes to staff. The message itself is
 * the `communications` row (inbound, stamped with the client's profile +
 * project so both sides' feeds show it under RLS); staff are then fanned-out
 * an in-app notification + email carrying the content, mirroring how sub bid
 * submissions and due-date reset requests notify.
 *
 * requireSession, not requireStaff — the RLS-scoped project read doubles as
 * the authorization check (clients only see their own projects' rows).
 */
export async function clientComposeMessage(input: {
  project_id: string
  subject?: string | null
  body: string
}): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  if (profile.role !== "client") {
    return { ok: false, error: "Only client accounts can message the team here." }
  }
  const validated = ClientComposeInput.safeParse(input)
  if (!validated.success) {
    return {
      ok: false,
      error: validated.error.issues[0]?.message ?? "Invalid input.",
    }
  }
  const parsed = validated.data
  const supabase = await createSupabaseServerClient()

  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, name, org_id")
    .eq("id", parsed.project_id)
    .maybeSingle()
  if (pErr) return { ok: false, error: pErr.message }
  if (!project) return { ok: false, error: "Project not found." }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return { ok: false, error: "Messaging isn't configured. Try again later." }
  }

  const clientName = profile.full_name || profile.email || "Client"
  const subject = parsed.subject?.trim() || null
  const body = parsed.body.trim()

  // The feed row IS the message — insert it directly (clients have no
  // communications write policy, so this goes through the admin client after
  // the RLS-scoped project read above proved membership).
  const { error: cErr } = await admin.from("communications").insert({
    // Admin-client insert — stamp the org from the membership-validated
    // project row (RLS proved the client belongs to this job, hence this org).
    org_id: project.org_id,
    channel: "email",
    direction: "inbound",
    status: "logged",
    project_id: project.id,
    profile_id: profile.id,
    from_address: profile.email,
    counterparty_name: clientName,
    subject,
    body,
    source: "app",
    source_kind: "client_message",
  })
  if (cErr) return { ok: false, error: cErr.message }

  // Staff fan-out: in-app notification + email with the content. Best-effort —
  // the message is already in the feed either way.
  const link = `/projects/${project.id}/communications`
  const title = `New message from ${clientName} — ${project.name}`
  // Only the job's own org hears about it — admin-client read, so the org
  // filter is explicit (membership via organization_members, like the QBO
  // webhook's recipient lookup).
  const { data: members } = await admin
    .from("organization_members")
    .select("profile_id")
    .eq("org_id", project.org_id)
  const memberIds = (members ?? []).map((m) => m.profile_id)
  const { data: staff } = memberIds.length
    ? await admin
        .from("profiles")
        .select("id, email, notifications_enabled")
        .eq("role", "staff")
        .in("id", memberIds)
    : { data: [] as { id: string; email: string | null; notifications_enabled: boolean }[] }
  // Per-job mutes (0121): the in-app rows are trigger-covered, the email
  // fan-out below is not — filter both here.
  const mutedForJob = await mutedProfileIdsForProject(
    admin,
    (staff ?? []).map((s) => s.id),
    project.id
  )
  const recipients = (staff ?? []).filter(
    (s) => s.notifications_enabled && !mutedForJob.has(s.id)
  )
  if (recipients.length) {
    const { error: nErr } = await admin.from("notifications").insert(
      recipients.map((s) => ({
        recipient_id: s.id,
        type: "client_message",
        title,
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
        link_url: link,
        project_id: project.id,
      }))
    )
    if (nErr) {
      console.warn("[clientComposeMessage] notifications failed:", nErr.message)
    }
    const emails = recipients
      .map((s) => s.email)
      .filter((e): e is string => !!e)
    if (emails.length) {
      // No `log` on purpose: this staff-internal alert carries the message,
      // but the feed row inserted above is the single logged copy.
      await sendEmail({
        to: emails,
        replyTo: profile.email ?? undefined,
        subject: subject ? `${title}: ${subject}` : title,
        text: `${body}\n\n—\nReply in the app: ${appUrl(link)}`,
      }).catch((e) => console.warn("[clientComposeMessage] email failed:", e))
    }
  }

  revalidatePath(link)
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
