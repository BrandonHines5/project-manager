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

export async function GET(req: Request) {
  // requireStaff() redirects non-staff to /projects; belt-and-suspenders since
  // this route mutates an external connection.
  await requireStaff()

  // On failure, bounce back to the settings page with a friendly ?error banner
  // (the route is hit via a plain <a> link, so a raw JSON 500 would render an
  // unstyled blob) — matching the callback route's behavior.
  const settingsUrl = new URL("/settings/quickbooks", req.url)

  if (!qboConfigured()) {
    settingsUrl.searchParams.set("error", "not_configured")
    return NextResponse.redirect(settingsUrl)
  }

  const state = crypto.randomUUID()
  const url = buildAuthorizeUrl(state)
  if (!url) {
    settingsUrl.searchParams.set("error", "authorize_url_failed")
    return NextResponse.redirect(settingsUrl)
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
