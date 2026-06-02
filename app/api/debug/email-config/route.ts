import { NextResponse } from "next/server"

// TEMPORARY diagnostic endpoint. Reports — as booleans / lengths only, never
// the secret values — whether the email-related env vars are actually present
// in the running deployment. This exists because Vercel's runtime logs in this
// project don't retain console output, so a silent `sendEmail` no-op (missing
// RESEND_API_KEY/RESEND_FROM_EMAIL) is otherwise impossible to confirm.
//
// Safe to expose: it leaks no credentials. RESEND_FROM_EMAIL is an email
// "from" address (not a secret) and is returned so we can verify it points at
// the verified send.hineshomes.com domain and has the right format. Remove
// this route once the email path is confirmed working.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const resendKey = process.env.RESEND_API_KEY ?? ""
  const resendFrom = process.env.RESEND_FROM_EMAIL ?? ""
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""

  return NextResponse.json({
    vercelEnv: process.env.VERCEL_ENV ?? null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    resend: {
      hasApiKey: resendKey.trim().length > 0,
      apiKeyLength: resendKey.length, // length only — never the value
      hasFrom: resendFrom.trim().length > 0,
      fromValue: resendFrom, // "from" address is not a secret
    },
    supabase: {
      hasServiceRoleKey: serviceRole.trim().length > 0,
      serviceRoleKeyLength: serviceRole.length,
    },
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
  })
}
