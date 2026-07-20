import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/lib/supabase/server"

/**
 * Password-recovery callback. The "forgot password" email links here.
 *
 * Unlike /auth/callback (Microsoft/Entra, which DENIES anyone not active in the
 * directory), this does NO directory check — it's for any password account
 * (trial owners, clients, trades) to set a new password. It exchanges the
 * recovery code for a short-lived session, then hands off to /reset-password,
 * which updates the password and signs back out. No app session is granted from
 * this flow, so it can't be used to bypass the login form's SSO rules.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = url.origin
  const code = url.searchParams.get("code")
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=reset", origin), {
      status: 303,
    })
  }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    console.warn("[auth/recovery] code exchange failed:", error.message)
    return NextResponse.redirect(new URL("/login?error=reset", origin), {
      status: 303,
    })
  }
  return NextResponse.redirect(new URL("/reset-password", origin), {
    status: 303,
  })
}
