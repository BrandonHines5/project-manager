import { redirect } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import type { Tables, Enums } from "@/lib/db/types"

export type SessionProfile = Tables<"profiles">
export type UserRole = Enums<"user_role">

/**
 * Returns the current user's profile row, or null if there is no session.
 *
 * Edge case handled: if an auth.users row exists but the public.profiles row
 * is missing (e.g. handle_new_user trigger failed at signup, or the row was
 * deleted manually), we used to return null which dead-locked the user at
 * /login with valid auth cookies. We now self-heal by inserting a minimal
 * profile row on-demand. The DB trigger trg_prevent_role_escalation prevents
 * a later UPDATE from elevating this profile's role.
 */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle()
  if (existing) return existing

  // Self-heal: insert a least-privilege client profile and re-fetch.
  // This insert runs as the authenticated user, so RLS must allow it; we rely
  // on the absence of restrictive INSERT policies (no policy ⇒ default deny)
  // — so this falls back to a service-side log + null return. The trigger
  // remains the primary code path; this is just a guardrail.
  const fullName =
    user.user_metadata?.full_name ||
    user.email?.split("@")[0] ||
    "User"
  const { data: created, error } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      email: user.email ?? null,
      full_name: fullName,
      role: "client" as UserRole,
    })
    .select("*")
    .maybeSingle()
  if (error) {
    // Race: another concurrent request inserted the profile first. Don't
    // bounce the user to /login — just re-fetch the row that won.
    if ((error as { code?: string }).code === "23505") {
      const { data: raced } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle()
      return raced ?? null
    }
    console.error("[auth] self-heal profile insert failed:", error.message)
    return null
  }
  return created ?? null
}

export async function requireSession(): Promise<SessionProfile> {
  const profile = await getSessionProfile()
  if (!profile) redirect("/login")
  return profile
}

export async function requireStaff(): Promise<SessionProfile> {
  const profile = await requireSession()
  if (profile.role !== "staff") redirect("/projects")
  return profile
}
