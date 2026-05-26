"use server"

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

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
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
    })
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
    await admin.auth.admin.deleteUser(newId)
    throw new Error(upErr.message)
  }

  revalidatePath("/team")
  return { id: newId }
}

export async function deleteTeamMember(id: string) {
  const me = await requireStaff()
  if (!id || typeof id !== "string") throw new Error("Missing user id.")
  if (id === me.id) {
    throw new Error("You can't delete your own account.")
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to .env.local (and Vercel) to enable deleting team members."
    )
  }

  // Guard: never delete the last remaining staff account.
  const supabase = await createSupabaseServerClient()
  const { data: target, error: lookupErr } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", id)
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
  const { error } = await admin.auth.admin.deleteUser(id)
  if (error) throw new Error(error.message)

  revalidatePath("/team")
}
