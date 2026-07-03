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
    // a staff profile on a password session is never valid while SSO is
    // configured.
    //
    // The check must use the session's `amr` claim, NOT
    // user.app_metadata.provider: `provider` records how the ACCOUNT was
    // created (plus linked identities), not how THIS session authenticated.
    // A staff account originally provisioned by email invite keeps
    // provider="email" forever — gating on it signed staff out immediately
    // after a successful Microsoft sign-in.
    if (SSO_ENABLED && existing.role === "staff") {
      const methods = await sessionAuthMethods(supabase)
      if (methods.includes("password")) {
        await supabase.auth.signOut()
        return null
      }
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

/**
 * Authentication methods used to establish the CURRENT session, read from
 * the access token's `amr` claim (e.g. [{ method: "oauth", … }], most
 * recent first). Password sign-ins carry method "password"; the Microsoft
 * OAuth path carries "oauth".
 *
 * The token was already validated by the getUser() call above — the same
 * cookie token is what authorizes every DB query, so a forged amr can't
 * grant anything the auth server wouldn't reject anyway. Returns [] when
 * the claim can't be read (fail open: the OAuth callback's directory check
 * and the login form's staff bounce remain the primary gates).
 */
async function sessionAuthMethods(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>
): Promise<string[]> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return []
  const payload = decodeJwtPayload(token)
  const amr = payload?.amr
  if (!Array.isArray(amr)) return []
  return amr
    .map((entry) =>
      entry && typeof entry === "object" && "method" in entry
        ? (entry as { method?: unknown }).method
        : null
    )
    .filter((m): m is string => typeof m === "string")
}

// Decodes a JWT's payload segment without verifying the signature (see
// sessionAuthMethods for why that's fine here). UTF-8-safe: claims embed
// user_metadata, which can contain non-ASCII names.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
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
