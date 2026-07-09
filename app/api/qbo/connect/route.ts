import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { requireStaff } from "@/lib/auth"
import { buildAuthorizeUrl } from "@/lib/quickbooks/oauth"
import { qboConfigured } from "@/lib/quickbooks/config"

/**
 * Starts the QuickBooks OAuth connect flow. Staff-only. Generates a CSRF state,
 * stashes it in an httpOnly cookie, and redirects the browser to Intuit's
 * consent screen. The callback verifies the state and exchanges the code.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const STATE_COOKIE = "qbo_oauth_state"

export async function GET() {
  // requireStaff() redirects non-staff to /projects; belt-and-suspenders since
  // this route mutates an external connection.
  await requireStaff()

  if (!qboConfigured()) {
    return NextResponse.json(
      { ok: false, error: "QuickBooks is not configured (QBO_CLIENT_ID / SECRET / REDIRECT_URI unset)." },
      { status: 500 }
    )
  }

  const state = crypto.randomUUID()
  const url = buildAuthorizeUrl(state)
  if (!url) {
    return NextResponse.json({ ok: false, error: "Could not build authorize URL" }, { status: 500 })
  }

  const jar = await cookies()
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete consent
  })

  return NextResponse.redirect(url)
}
