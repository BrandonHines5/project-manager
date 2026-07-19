"use server"

import { z } from "zod"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { CLIENT_DISCLAIMER_VERSION } from "@/lib/client-portal/disclaimer"

const Input = z.object({
  token: z.string(),
  password: z.string().min(8, "Use at least 8 characters").max(200),
  disclaimer_accepted: z.literal(true, {
    message: "Please accept the disclaimer to continue.",
  }),
})

export type AcceptClientInviteResult = { ok: true } | { ok: false; error: string }

/**
 * Public accept-invite handler for the client portal (item 7). Runs on the
 * service-role admin client — there are no anon RLS policies on client_invites,
 * so the unguessable token is the credential (same model as the bid/PO public
 * pages). Creates or links the client's account, records disclaimer acceptance,
 * and adds them to the project as a client member. Never throws — returns a
 * typed error so the public form can show a real message.
 */
export async function acceptClientInvite(input: {
  token: string
  password: string
  disclaimer_accepted: boolean
}): Promise<AcceptClientInviteResult> {
  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }
  const { token, password } = parsed.data
  if (!ACCESS_TOKEN_RE.test(token)) {
    return { ok: false, error: "This invite link is invalid or has expired." }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return {
      ok: false,
      error:
        "Sign-up is not configured on the server yet. Please contact Hines Homes.",
    }
  }

  const { data: invite, error: inviteErr } = await admin
    .from("client_invites")
    .select("id, email, name, project_id, accepted_at")
    .eq("token", token)
    .maybeSingle()
  if (inviteErr) {
    return { ok: false, error: "Could not verify your invite. Please try again." }
  }
  if (!invite) {
    return { ok: false, error: "This invite link is invalid or has been revoked." }
  }
  if (invite.accepted_at) {
    return {
      ok: false,
      error:
        "This invite has already been used. Sign in with your email and password.",
    }
  }

  const email = invite.email.trim().toLowerCase()
  const fullName = invite.name?.trim() || email.split("@")[0]
  const now = new Date().toISOString()

  // Is there already a profile for this email?
  const { data: existingProfiles } = await admin
    .from("profiles")
    .select("id, role")
    .ilike("email", email)
    .limit(1)
  const existing = existingProfiles?.[0]

  let profileId: string
  if (existing) {
    // Don't let an invite silently take over a staff/trade account.
    if (existing.role !== "client") {
      return {
        ok: false,
        error:
          "An account already exists for this email. Please contact Hines Homes.",
      }
    }
    profileId = existing.id
    const { error: pwErr } = await admin.auth.admin.updateUserById(profileId, {
      password,
    })
    if (pwErr) return { ok: false, error: pwErr.message }
    const { error: discErr } = await admin
      .from("profiles")
      .update({ disclaimer_accepted_at: now, disclaimer_version: CLIENT_DISCLAIMER_VERSION })
      .eq("id", profileId)
    if (discErr) {
      return { ok: false, error: "Could not record disclaimer acceptance." }
    }
  } else {
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      })
    if (createErr || !created?.user) {
      return {
        ok: false,
        error:
          createErr?.message ??
          "Could not create your account. It may already exist — try signing in.",
      }
    }
    profileId = created.user.id
    // handle_new_user inserts a role='client' profile; upsert reaffirms it and
    // stamps the disclaimer in one shot (admin bypasses the escalation trigger).
    const { error: upsertErr } = await admin.from("profiles").upsert(
      {
        id: profileId,
        email,
        full_name: fullName,
        role: "client",
        disclaimer_accepted_at: now,
        disclaimer_version: CLIENT_DISCLAIMER_VERSION,
      },
      { onConflict: "id" }
    )
    if (upsertErr) {
      return { ok: false, error: "Could not record disclaimer acceptance." }
    }
  }

  // Add them to the project as a client member (idempotent).
  const { error: memberErr } = await admin
    .from("project_members")
    .insert({ project_id: invite.project_id, profile_id: profileId })
  if (memberErr && (memberErr as { code?: string }).code !== "23505") {
    return { ok: false, error: memberErr.message }
  }

  // Enroll them in the project's org (idempotent). Without this a post-0099
  // client fails every is_org_member gate — e.g. reading the decision
  // disclaimer (0103). Membership writes are service-role-only until B5, so
  // this rides the admin client; best-effort like the notification fan-outs
  // (a failure here must not eat an otherwise-accepted invite — the 0099-era
  // backfill pattern can repair it).
  const { data: inviteProject } = await admin
    .from("projects")
    .select("org_id")
    .eq("id", invite.project_id)
    .maybeSingle()
  if (inviteProject?.org_id) {
    const { error: orgErr } = await admin.from("organization_members").insert({
      org_id: inviteProject.org_id,
      profile_id: profileId,
      member_role: "member",
    })
    if (orgErr && (orgErr as { code?: string }).code !== "23505") {
      console.warn("[acceptInvite] org enrollment failed:", orgErr.message)
    }
  }

  // Claim the invite (compare-and-swap on accepted_at).
  await admin
    .from("client_invites")
    .update({ accepted_at: now, accepted_profile_id: profileId })
    .eq("id", invite.id)
    .is("accepted_at", null)

  return { ok: true }
}
