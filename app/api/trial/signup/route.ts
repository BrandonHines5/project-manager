import { NextResponse } from "next/server"
import { z } from "zod"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { provisionOrgCore } from "@/lib/provisioning/core"

/**
 * Public self-serve trial signup (Stage S, part 2). Called SERVER-TO-SERVER by
 * the separate sales site — a visitor there signs up for a trial, the sales
 * site POSTs here, and we mint a brand-new SANDBOX org + owner (status
 * 'sandbox_active', a 7-day sandbox_expires_at). The org is seeded from Hines
 * catalogs exactly like operator provisioning; only its lifecycle differs.
 * Real provisioned/Hines orgs never touch this path, so they never see a
 * paywall or an expiry.
 *
 * Abuse protection, in order:
 *  1. TRIAL_SIGNUP_SECRET shared header — the primary gate. Only the sales-site
 *     backend holds it. Unset → the endpoint is closed (503).
 *  2. Turnstile (optional, env-gated) — CAPTCHA the sales site can add later by
 *     setting TURNSTILE_SECRET_KEY and passing turnstileToken; skipped until then.
 *  3. record_trial_signup_attempt — a serverless-safe DB rate limit (5/IP/hour,
 *     3/email/day) as defense-in-depth if the shared secret ever leaks.
 *
 * The response returns a one-time temp password to the (secret-authenticated)
 * caller — same trust tier as the operator UI. The sales site delivers the
 * credentials / signs the user in; the password never surfaces publicly.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TRIAL_DAYS = 7

const Body = z.object({
  orgName: z.string().trim().min(1, "Organization name is required.").max(120),
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,62}$/,
      "Slug must be 2–63 chars: lowercase letters, digits, and dashes."
    ),
  ownerName: z.string().trim().min(1, "Owner name is required.").max(200),
  ownerEmail: z.string().trim().email("Enter a valid owner email.").max(200),
  turnstileToken: z.string().optional(),
})

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0]?.trim() || null
  return req.headers.get("x-real-ip")?.trim() || null
}

/** True unless Turnstile is configured AND the token fails to verify. */
async function verifyTurnstile(
  token: string | undefined,
  ip: string | null
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return true // not configured → CAPTCHA not enforced yet
  if (!token) return false
  const form = new URLSearchParams()
  form.set("secret", secret)
  form.set("response", token)
  if (ip) form.set("remoteip", ip)
  try {
    const resp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    )
    const data = (await resp.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  // 1. Shared-secret gate — the primary protection. Fail closed if unset.
  const secret = process.env.TRIAL_SIGNUP_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Trial signup is not configured." },
      { status: 503 }
    )
  }
  const bearer = req.headers.get("authorization") ?? ""
  const headerSecret = req.headers.get("x-trial-signup-secret") ?? ""
  if (bearer !== `Bearer ${secret}` && headerSecret !== secret) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 401 })
  }

  // 2. Body.
  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    )
  }
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    )
  }
  const { orgName, slug, ownerName, ownerEmail, turnstileToken } = parsed.data
  const ip = clientIp(req)

  // 3. Turnstile (only enforced when TURNSTILE_SECRET_KEY is set).
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    return NextResponse.json(
      { ok: false, error: "CAPTCHA verification failed." },
      { status: 403 }
    )
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Server is not configured (service role missing)." },
      { status: 500 }
    )
  }

  // 4. Rate limit (records the attempt and returns whether it's within limits).
  const { data: allowed, error: rlErr } = await admin.rpc(
    "record_trial_signup_attempt",
    // The function treats a blank IP as "unattributed" (skips the IP limit);
    // pass "" when the headers gave us nothing.
    { p_ip: ip ?? "", p_email: ownerEmail }
  )
  if (rlErr) {
    return NextResponse.json(
      { ok: false, error: "Couldn't process the request." },
      { status: 500 }
    )
  }
  if (allowed === false) {
    return NextResponse.json(
      { ok: false, error: "Too many signup attempts. Please try again later." },
      { status: 429 }
    )
  }

  // 5. Mint the sandbox org + owner.
  const result = await provisionOrgCore(admin, {
    orgName,
    slug,
    ownerName,
    ownerEmail,
    lifecycle: "sandbox_active",
    trialDays: TRIAL_DAYS,
  })
  if (!result.ok) {
    // Duplicate owner email / taken slug are the caller's to fix (409); any
    // other failure is a server-side problem (500).
    const conflict = /already has an account|already taken/i.test(result.error)
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: conflict ? 409 : 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    orgId: result.orgId,
    ownerEmail: result.ownerEmail,
    tempPassword: result.tempPassword,
    expiresAt: result.sandboxExpiresAt,
  })
}
