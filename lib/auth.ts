import { redirect } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import type { Tables, Enums } from "@/lib/db/types"

export type SessionProfile = Tables<"profiles">
export type UserRole = Enums<"user_role">

// Staff SSO is only offered when the Entra/Azure provider is wired up —
// same signal the login form uses (app/login/login-form.tsx). When unset,
// password sign-in is the only path and the staff gate below must not fire,
// otherwise a password-only deployment would lock every staff member out.
const SSO_ENABLED = process.env.NEXT_PUBLIC_ENTRA_SSO_ENABLED === "1"

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
  if (existing) {
    // Staff must authenticate via Microsoft so the directory governs their
    // access — is_active/role are enforced on the OAuth callback
    // (app/auth/callback/route.ts), and the login form bounces staff
    // password sign-ins client-side. But a staff account that has a
    // password (invite/reset via /team) can hit the Supabase auth endpoint
    // directly with signInWithPassword and skip both gates — including
    // after being deactivated in the directory. Kill such sessions here:
    // a staff profile on a pure password session is never valid while SSO
    // is configured.
    if (
      SSO_ENABLED &&
      existing.role === "staff" &&
      user.app_metadata?.provider === "email"
    ) {
      await supabase.auth.signOut()
      return null
    }
    return existing
  }

  // Self-heal: insert a least-privilege client profile and re-fetch.
  // This insert runs as the authenticated user, so RLS must allow it; we rely
  // on the absence of restrictive INSERT policies (no policy ⇒ default deny)
  // — so this falls back to a service-side log + null return. The trigger
  // remains the primary code path; this is just a guardrail.
  const fullName =
    user.user_metadata?.full_name ||
    user.email?.split("@")[0] ||
    "User"
  // Self-heal should be rare — the handle_new_user trigger covers the
  // normal signup path. When it fires, log enough context to investigate
  // without dumping raw PII (CodeRabbit #29). user_id collapses to the
  // first 8 chars (UUID prefix is enough to correlate with Supabase logs);
  // email collapses to "<first-char>***@<domain>" which is identifiable
  // to the operator but doesn't expose the inbox.
  console.warn(
    "[auth] self-heal firing — profiles row missing for user",
    JSON.stringify({
      user_id_prefix: user.id.slice(0, 8),
      email_redacted: redactEmail(user.email),
      assumed_role: "client",
    })
  )
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

// Collapses an email to "<first>***@<domain>". Returns null for null input
// and "***@<no-at>" for malformed addresses so a log line is never empty.
function redactEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.indexOf("@")
  if (at <= 0) return "***@" + email
  return email[0] + "***@" + email.slice(at + 1)
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
