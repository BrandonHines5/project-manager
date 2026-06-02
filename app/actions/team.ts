"use server"

import { randomInt } from "node:crypto"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const UpdateProfileInput = z
  .object({
    id: z.string(),
    full_name: z.string().min(1).max(200),
    role: z.enum(["staff", "trade", "client"]),
    company_id: optStr,
    phone: optStr,
    email_digest_pref: z
      .enum(["immediate", "daily", "off"])
      .default("immediate"),
    financial_access: z.boolean().default(false),
  })
  .passthrough()

export type UpdateProfileInputT = z.infer<typeof UpdateProfileInput>

const InviteTeamMemberInput = z.object({
  email: z.string().email().max(200),
  full_name: z.string().min(1).max(200),
  role: z.enum(["staff", "trade", "client"]),
  password: z.string().min(8).max(200),
})

export type InviteTeamMemberInputT = z.infer<typeof InviteTeamMemberInput>

const DeleteTeamMemberInput = z.object({
  id: z.string().uuid(),
})

const ResetPasswordInput = z.object({
  id: z.string().uuid(),
})

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

// Generate a 14-char temporary password using crypto-grade randomness. Mirrors
// the client-side generator in the team-client InviteDialog so resets and new
// invites produce the same shape of password. Server-side because the result
// is the auth secret — we don't want it bouncing through the browser.
//
// Uses crypto.randomInt for uniform character selection (no modulo bias).
function generateTempPassword() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  const symbols = "!@#$%&*?"
  let out = ""
  for (let i = 0; i < 13; i++) out += alphabet[randomInt(alphabet.length)]
  out += symbols[randomInt(symbols.length)]
  return out
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
      email_digest_pref: parsed.email_digest_pref,
      financial_access: parsed.financial_access,
    })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath("/team")
}

const SetNotificationsInput = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
})

/**
 * Master on/off switch for a team member's site notifications. When off, the
 * `trg_skip_muted_notifications` trigger drops their in-app + digest rows and
 * the direct-email paths skip them (migration 0036).
 */
export async function setMemberNotifications(input: {
  id: string
  enabled: boolean
}) {
  await requireStaff()
  const parsed = SetNotificationsInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("profiles")
    .update({ notifications_enabled: parsed.enabled })
    .eq("id", parsed.id)
  if (error) throw new Error(error.message)
  revalidatePath("/team")
}

export async function inviteTeamMember(input: InviteTeamMemberInputT) {
  await requireStaff()
  const parsed = InviteTeamMemberInput.parse(input)

  const admin = createSupabaseAdminClient()
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to .env.local (and Vercel) to enable adding team members."
    )
  }

  // 1. Create the auth user. The handle_new_user trigger inserts the
  // profiles row with role='client' (least privilege).
  const { data, error } = await admin.auth.admin.createUser({
    email: parsed.email,
    password: parsed.password,
    email_confirm: true,
    user_metadata: { full_name: parsed.full_name },
  })
  if (error) throw new Error(error.message)
  const newId = data.user?.id
  if (!newId) throw new Error("createUser succeeded but returned no user id.")

  // 2. Promote to the requested role + set full_name. The calling session is
  // staff, so prevent_role_escalation lets this through.
  const supabase = await createSupabaseServerClient()
  const { error: upErr } = await supabase
    .from("profiles")
    .update({ role: parsed.role, full_name: parsed.full_name })
    .eq("id", newId)
  if (upErr) {
    // Roll back the auth user so we don't leave an orphan with the wrong role.
    // If the rollback ALSO fails (rare but possible) we want to surface both
    // errors — otherwise staff see "profile update failed" but never learn
    // that an orphaned auth user is still around.
    const { error: rollbackErr } = await admin.auth.admin.deleteUser(newId)
    if (rollbackErr) {
      throw new Error(
        `Profile update failed: ${upErr.message}. Rollback also failed (orphaned auth user ${newId}): ${rollbackErr.message}`
      )
    }
    throw new Error(upErr.message)
  }

  revalidatePath("/team")
  return { id: newId }
}

/**
 * Generate a new temporary password for a team member and return it so the
 * caller can show & share it. Uses the admin client so we don't depend on
 * SMTP / the /recover email flow.
 */
export async function resetTeamMemberPassword(id: string) {
  await requireStaff()
  const parsed = ResetPasswordInput.parse({ id })

  const admin = createSupabaseAdminClient()
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to .env.local (and Vercel) to enable password resets."
    )
  }

  const password = generateTempPassword()
  const { error } = await admin.auth.admin.updateUserById(parsed.id, {
    password,
  })
  if (error) throw new Error(error.message)

  return { password }
}

export async function deleteTeamMember(id: string) {
  const me = await requireStaff()
  const parsed = DeleteTeamMemberInput.parse({ id })
  if (parsed.id === me.id) {
    throw new Error("You can't delete your own account.")
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to .env.local (and Vercel) to enable deleting team members."
    )
  }

  // Guard: never delete the last remaining staff account. This is
  // best-effort — a true atomic check would need a DB function that also
  // performs the auth.users delete, which is more involved than the value
  // for a 1-2-admin tool. The race window is sub-second between two
  // concurrent admin sessions.
  const supabase = await createSupabaseServerClient()
  const { data: target, error: lookupErr } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", parsed.id)
    .single()
  if (lookupErr) throw new Error(lookupErr.message)
  if (target?.role === "staff") {
    const { count, error: countErr } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "staff")
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) <= 1) {
      throw new Error("Refusing to delete the last remaining staff account.")
    }
  }

  // Deleting the auth user cascades to public.profiles via the FK.
  const { error } = await admin.auth.admin.deleteUser(parsed.id)
  if (error) throw new Error(error.message)

  revalidatePath("/team")
}
