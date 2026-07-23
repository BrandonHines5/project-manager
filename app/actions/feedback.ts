"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireSession, requireStaff } from "@/lib/auth"
import { getActiveOrgId, LEGACY_ORG_ID } from "@/lib/org"
import { sendEmail, appUrl } from "@/lib/email"
import { FEEDBACK_TYPES, FEEDBACK_STATUSES } from "@/lib/feedback"

const optStr = z.string().nullish()

const SubmitInput = z.object({
  request_type: z.enum(FEEDBACK_TYPES).default("Feature Request"),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).nullish(),
})
export type SubmitFeedbackInput = z.infer<typeof SubmitInput>

// Any signed-in user (staff, trade, client) can file a request. We stamp the
// submitter from the session — the client never gets to claim someone else's
// name, and RLS (feedback_insert_self) double-checks submitted_by_id == uid.
export async function submitFeedback(input: SubmitFeedbackInput) {
  const profile = await requireSession()
  const result = SubmitInput.safeParse(input)
  if (!result.success) {
    throw new Error(result.error.issues[0].message)
  }
  const { request_type, title, description } = result.data
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, profile.id)
  const { error } = await supabase.from("feedback_requests").insert({
    org_id: orgId,
    submitted_by_id: profile.id,
    submitted_by: profile.full_name,
    submitted_by_email: profile.email,
    request_type,
    title,
    description: description && description !== "" ? description : null,
  })
  if (error) throw new Error(error.message)

  // A request from a builder org is a message TO the platform operator (0124):
  // it lands in the operator's own Feedback & Requests queue via RLS, and this
  // email makes sure it's seen without polling that page. Legacy (Hines)
  // submissions keep the internal flow — the dashboard banner, no email.
  // Best-effort: a mail hiccup must never fail the submission.
  if (orgId !== LEGACY_ORG_ID) {
    await notifyPlatformOfSubmission({
      orgId,
      submitterName: profile.full_name ?? "A user",
      submitterEmail: profile.email ?? null,
      requestType: request_type,
      title,
      description: description && description !== "" ? description : null,
    }).catch((e) =>
      console.warn("[feedback] platform notification email failed:", e)
    )
  }

  revalidatePath("/feedback")
  // Keeps the staff "new requests" surface on the dashboard in sync.
  revalidatePath("/projects")
}

// Emails the platform operators (legacy-org OWNERS — the same set RLS lets
// triage every org's requests) about a builder-org submission. Runs on the
// admin client: the submitter's session can't read another org's members.
async function notifyPlatformOfSubmission(args: {
  orgId: string
  submitterName: string
  submitterEmail: string | null
  requestType: string
  title: string
  description: string | null
}) {
  const admin = createSupabaseAdminClient()
  if (!admin) return

  const [{ data: org }, { data: ownerRows }] = await Promise.all([
    admin
      .from("organizations")
      .select("name")
      .eq("id", args.orgId)
      .maybeSingle(),
    admin
      .from("organization_members")
      .select("profile_id")
      .eq("org_id", LEGACY_ORG_ID)
      .eq("member_role", "owner"),
  ])
  const ownerIds = (ownerRows ?? []).map((r) => r.profile_id)
  if (ownerIds.length === 0) return
  const { data: owners } = await admin
    .from("profiles")
    .select("email, notifications_enabled")
    .in("id", ownerIds)
  // Respect the per-user master switch like every other email fan-out.
  const recipients = (owners ?? [])
    .filter((p) => p.notifications_enabled !== false)
    .map((p) => p.email)
    .filter((e): e is string => !!e)
  if (recipients.length === 0) return

  const orgName = org?.name ?? "a builder account"
  const from = args.submitterEmail
    ? `${args.submitterName} (${args.submitterEmail})`
    : args.submitterName
  await sendEmail({
    to: recipients,
    // Hitting "Reply" reaches the requestor directly; the in-app admin note
    // stays the tracked channel.
    replyTo: args.submitterEmail ?? undefined,
    subject: `New update request from ${orgName}: ${args.title}`,
    text:
      `${from} at ${orgName} submitted a ${args.requestType.toLowerCase()}.\n\n` +
      `${args.title}\n` +
      (args.description ? `\n${args.description}\n` : "") +
      `\nReview and reply: ${appUrl("/feedback")}`,
    // Platform mail to the operator rides the legacy identity; staff-internal,
    // so it's deliberately not logged to communications.
    orgId: LEGACY_ORG_ID,
  })
}

const StatusInput = z.object({
  id: z.string().uuid(),
  status: z.enum(FEEDBACK_STATUSES),
})

// Triage is staff-only. RLS would reject a non-staff update too, but failing
// fast here gives a clean error instead of a silent zero-row update.
export async function updateFeedbackStatus(input: z.infer<typeof StatusInput>) {
  await requireStaff()
  const result = StatusInput.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0].message)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("feedback_requests")
    .update({ status: result.data.status })
    .eq("id", result.data.id)
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
}

const NotesInput = z.object({
  id: z.string().uuid(),
  admin_notes: optStr,
})

export async function updateFeedbackNotes(input: z.infer<typeof NotesInput>) {
  const profile = await requireStaff()
  const result = NotesInput.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0].message)
  const notes = result.data.admin_notes?.trim()
  const supabase = await createSupabaseServerClient()
  // Read-before-write so we know whether this edit is a NEW reply worth
  // emailing (cross-org rows below). Anyone RLS lets update can also read.
  const { data: existing } = await supabase
    .from("feedback_requests")
    .select(
      "org_id, title, request_type, admin_notes, submitted_by_id, submitted_by_email"
    )
    .eq("id", result.data.id)
    .maybeSingle()
  // `.select` returns the rows the update actually touched — RLS rejecting
  // the write is a silent zero-row no-op, and the reply email below must not
  // fire on a write that didn't land.
  const { data: updated, error } = await supabase
    .from("feedback_requests")
    .update({ admin_notes: notes && notes !== "" ? notes : null })
    .eq("id", result.data.id)
    .select("id")
  if (error) throw new Error(error.message)

  // A note on a builder org's request is the platform's reply to the
  // requestor (0124). Their own Feedback & Requests page shows it, but they
  // shouldn't have to poll — email them the reply too. Legacy (Hines) rows
  // keep the internal flow: no email, the dashboard panel covers it.
  if (
    updated &&
    updated.length > 0 &&
    existing &&
    existing.org_id !== LEGACY_ORG_ID &&
    notes &&
    notes !== (existing.admin_notes ?? "").trim() &&
    existing.submitted_by_email &&
    existing.submitted_by_id !== profile.id &&
    (await requestorWantsEmail(existing.submitted_by_id))
  ) {
    await sendEmail({
      to: existing.submitted_by_email,
      // Their reply comes back to the staffer who wrote the note.
      replyTo: profile.email ?? undefined,
      subject: `Update on your request: ${existing.title}`,
      text:
        `${profile.full_name ?? "The app team"} replied to your ` +
        `${existing.request_type.toLowerCase()} "${existing.title}":\n\n` +
        `${notes}\n\n` +
        `Track it under Feedback & Requests: ${appUrl("/feedback")}`,
      fromName: "BuildFox",
      // The platform replies under the legacy identity; not a counterparty
      // send, so it's deliberately not logged to communications.
      orgId: LEGACY_ORG_ID,
    }).catch((e) => console.warn("[feedback] reply email failed:", e))
  }

  revalidatePath("/feedback")
  // The dashboard's feedback panels render off this data too — same pairing
  // submitFeedback uses.
  revalidatePath("/projects")
}

// Respect the requestor's master notifications switch like every other email
// fan-out. Admin client because the platform admin's session doesn't share an
// org with the requestor (profiles reads are org-scoped). Fails OPEN — a
// profile-read hiccup shouldn't swallow the reply; a deleted profile (null
// id) keeps the snapshot address usable.
async function requestorWantsEmail(profileId: string | null): Promise<boolean> {
  if (!profileId) return true
  const admin = createSupabaseAdminClient()
  if (!admin) return true
  const { data } = await admin
    .from("profiles")
    .select("notifications_enabled")
    .eq("id", profileId)
    .maybeSingle()
  return data?.notifications_enabled !== false
}

export async function deleteFeedback(input: { id: string }) {
  await requireStaff()
  const id = z.string().uuid().parse(input.id)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("feedback_requests")
    .delete()
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
  revalidatePath("/projects")
}
