import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId } from "@/lib/org"
import { exchangeCodeForTokens } from "@/lib/quickbooks/oauth"
import { saveQboConnection } from "@/lib/quickbooks/storage"
import { getCompanyInfo } from "@/lib/quickbooks/client"
import { qboEnvironment } from "@/lib/quickbooks/config"

/**
 * OAuth redirect target. Intuit sends ?code, ?state, ?realmId (the company id).
 * We verify the CSRF state against the cookie set by /api/qbo/connect, exchange
 * the code for tokens, persist the connection, then bounce back to the settings
 * page with a status flag. Errors redirect with ?error=<reason> rather than
 * dumping a stack to the browser.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const STATE_COOKIE = "qbo_oauth_state"
const SETTINGS_PATH = "/settings/quickbooks"

export async function GET(req: Request) {
  const profile = await requireStaff()
  const { searchParams } = new URL(req.url)
  const settingsUrl = new URL(SETTINGS_PATH, req.url)

  const fail = async (reason: string) => {
    const jar = await cookies()
    jar.delete(STATE_COOKIE)
    settingsUrl.searchParams.set("error", reason)
    return NextResponse.redirect(settingsUrl)
  }

  // Intuit surfaces a user denial as ?error=access_denied.
  const oauthError = searchParams.get("error")
  if (oauthError) return fail(oauthError)

  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const realmId = searchParams.get("realmId")
  if (!code || !state || !realmId) return fail("missing_params")

  const jar = await cookies()
  const expectedState = jar.get(STATE_COOKIE)?.value
  if (!expectedState || expectedState !== state) return fail("state_mismatch")

  // The connection belongs to the staffer's ACTIVE org — resolved from the
  // same authenticated session that started the flow, so a forged state
  // can't re-home it (and the save refuses a realm another org owns).
  let orgId: string
  try {
    const supabase = await createSupabaseServerClient()
    orgId = await getActiveOrgId(supabase, profile.id)
  } catch {
    return fail("no_org")
  }

  const tokens = await exchangeCodeForTokens(code)
  if (!tokens) return fail("token_exchange_failed")

  const environment = qboEnvironment()
  const saved = await saveQboConnection(orgId, {
    realm_id: realmId,
    environment,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: tokens.access_token_expires_at,
    refresh_token_expires_at: tokens.refresh_token_expires_at,
    company_name: null,
    connected_by: profile.id,
  })
  if (!saved.ok) {
    return fail(saved.reason === "realm_other_org" ? "realm_other_org" : "save_failed")
  }

  // Best-effort: fetch the company name for display (reads the just-saved
  // token). A failure here doesn't undo the successful connection.
  try {
    const company = await getCompanyInfo(orgId)
    const name = company?.CompanyName ?? company?.LegalName ?? null
    if (name) {
      await saveQboConnection(orgId, {
        realm_id: realmId,
        environment,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        access_token_expires_at: tokens.access_token_expires_at,
        refresh_token_expires_at: tokens.refresh_token_expires_at,
        company_name: name,
        connected_by: profile.id,
      })
    }
  } catch (e) {
    console.warn("[qbo] company info fetch failed:", e instanceof Error ? e.message : e)
  }

  const jar2 = await cookies()
  jar2.delete(STATE_COOKIE)
  settingsUrl.searchParams.set("connected", "1")
  return NextResponse.redirect(settingsUrl)
}
