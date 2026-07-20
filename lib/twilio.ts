import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getOrgIntegration } from "@/lib/integrations/org"

// Platform-managed SMS via Twilio (S — messaging). Unlike Quo/OpenPhone
// (bring-your-own account + API key, kept as-is for the legacy Hines org),
// Twilio is a PLATFORM account: one master credential pair in env
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) provisions a dedicated number for
// each builder org. The org never enters a key — onboarding just provisions a
// number. The per-org number lives in `org_integrations` provider 'twilio'
// `config` (phoneNumber + its Twilio SID); there is NO per-org secret (the
// master creds are env), so this row stores nothing sealed.

/** org_integrations provider slug for platform-managed Twilio SMS. */
export const TWILIO_PROVIDER = "twilio"

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"

/** Whether the platform Twilio account is wired up (env creds present). */
export function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
}

/** Basic-auth header for the master account, or null when unconfigured. */
function twilioAuthHeader(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return null
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64")
}

type TwilioResult = {
  ok: boolean
  status: number
  json: Record<string, unknown> | null
  error: string | null
}

/**
 * One authenticated call against the platform account's REST API. GET when
 * `params` is undefined, else a form-encoded POST. Never throws — a transport
 * error resolves to `{ ok: false }` so callers degrade gracefully.
 */
async function twilioRequest(
  path: string,
  params?: Record<string, string>,
  timeoutMs = 15_000
): Promise<TwilioResult> {
  const auth = twilioAuthHeader()
  const sid = process.env.TWILIO_ACCOUNT_SID
  if (!auth || !sid) {
    return { ok: false, status: 0, json: null, error: "Twilio not configured" }
  }
  try {
    const res = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/${path}`, {
      method: params ? "POST" : "GET",
      headers: {
        Authorization: auth,
        ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
      // Sends use a tight 5s cap (a slow send shouldn't hold an action open,
      // matching the Quo path); provisioning passes a longer bound.
      signal: AbortSignal.timeout(timeoutMs),
    })
    let json: Record<string, unknown> | null = null
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      json = null
    }
    if (!res.ok) {
      // Twilio error bodies carry a human 'message' + numeric 'code'.
      const message =
        (json && typeof json.message === "string" && json.message) ||
        `Twilio API ${res.status}`
      return { ok: false, status: res.status, json, error: message }
    }
    return { ok: true, status: res.status, json, error: null }
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return { ok: false, status: 0, json: null, error: "Twilio request timed out" }
    }
    return {
      ok: false,
      status: 0,
      json: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound SMS

/**
 * Sends one SMS through the platform Twilio account. `from` must be a number
 * the account owns (the org's provisioned number). Pure transport — the
 * caller (sendQuoSms's dispatch) handles communications logging so both
 * providers log in one place. `providerId` is the Twilio Message SID.
 */
export async function sendTwilioSms(opts: {
  to: string
  from: string
  content: string
}): Promise<{ sent: boolean; reason?: string; providerId?: string }> {
  const result = await twilioRequest(
    "Messages.json",
    { To: opts.to, From: opts.from, Body: opts.content },
    5_000
  )
  if (!result.ok) {
    console.error("[twilio] send failed:", result.error)
    return { sent: false, reason: result.error ?? "Twilio send failed" }
  }
  const sid =
    result.json && typeof result.json.sid === "string" ? result.json.sid : undefined
  return { sent: true, providerId: sid }
}

// ---------------------------------------------------------------------------
// Number provisioning

export type AvailableNumber = { phoneNumber: string; friendlyName: string }

/**
 * Searches the platform account for buyable US local numbers, optionally
 * constrained to an area code. SMS-capable only. Returns [] when Twilio isn't
 * configured or the search fails.
 */
export async function searchAvailableNumbers(
  areaCode?: string
): Promise<AvailableNumber[]> {
  const params = new URLSearchParams({ SmsEnabled: "true", PageSize: "10" })
  if (areaCode) params.set("AreaCode", areaCode)
  const result = await twilioRequest(
    `AvailablePhoneNumbers/US/Local.json?${params.toString()}`
  )
  if (!result.ok || !result.json) return []
  const list = result.json.available_phone_numbers
  if (!Array.isArray(list)) return []
  return list
    .map((n) => {
      const row = n as Record<string, unknown>
      return {
        phoneNumber: typeof row.phone_number === "string" ? row.phone_number : "",
        friendlyName:
          typeof row.friendly_name === "string" ? row.friendly_name : "",
      }
    })
    .filter((n) => n.phoneNumber)
}

/**
 * Buys a specific number under the platform account and points its inbound-SMS
 * webhook at `smsUrl`. Returns the new number + its Twilio SID on success.
 */
export async function buyTwilioNumber(opts: {
  phoneNumber: string
  smsUrl: string
}): Promise<{ ok: true; phoneNumber: string; sid: string } | { ok: false; error: string }> {
  const result = await twilioRequest("IncomingPhoneNumbers.json", {
    PhoneNumber: opts.phoneNumber,
    SmsUrl: opts.smsUrl,
    SmsMethod: "POST",
  })
  if (!result.ok || !result.json) {
    return { ok: false, error: result.error ?? "Couldn't buy the number" }
  }
  const sid = typeof result.json.sid === "string" ? result.json.sid : null
  const number =
    typeof result.json.phone_number === "string"
      ? result.json.phone_number
      : opts.phoneNumber
  if (!sid) {
    // Defensive: Twilio always returns a sid on a successful buy, but if it
    // ever doesn't we've bought a number we can't release programmatically —
    // surface the number so it can be cleaned up manually before it bills.
    console.error(
      `[twilio] bought ${number} but response had no sid — release it manually to stop billing`
    )
    return { ok: false, error: "Twilio didn't return a number id" }
  }
  return { ok: true, phoneNumber: number, sid }
}

/**
 * Releases (deletes) a provisioned number by its Twilio SID so the account
 * stops paying for it. A 404 is treated as success (already gone).
 */
export async function releaseTwilioNumber(
  sid: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = twilioAuthHeader()
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  if (!auth || !accountSid) return { ok: false, error: "Twilio not configured" }
  try {
    const res = await fetch(
      `${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}.json`,
      {
        method: "DELETE",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(15_000),
      }
    )
    // 204 = deleted, 404 = already gone — both fine.
    if (res.ok || res.status === 404) return { ok: true }
    return { ok: false, error: `Twilio API ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Per-org config

export type TwilioConfig = { phoneNumber: string; phoneNumberSid: string }

/**
 * The org's provisioned Twilio number, or null when it has none (or Twilio
 * isn't configured). Reads `org_integrations` provider 'twilio' via the admin
 * client (the table is service-role-only). Fails closed to null on any read
 * error — a hiccup must never misroute a send.
 */
export async function resolveTwilioConfig(
  orgId: string | null | undefined
): Promise<TwilioConfig | null> {
  if (!orgId || !twilioConfigured()) return null
  const admin = createSupabaseAdminClient()
  if (!admin) return null
  try {
    const integ = await getOrgIntegration(admin, orgId, TWILIO_PROVIDER)
    if (!integ || !integ.enabled) return null
    const phoneNumber =
      typeof integ.config?.phoneNumber === "string" ? integ.config.phoneNumber : null
    if (!phoneNumber) return null
    const phoneNumberSid =
      typeof integ.config?.phoneNumberSid === "string"
        ? integ.config.phoneNumberSid
        : ""
    return { phoneNumber, phoneNumberSid }
  } catch (e) {
    console.error(
      "[twilio] org integration read failed:",
      e instanceof Error ? e.message : e
    )
    return null
  }
}

/**
 * Which org owns a given provisioned number — the inbound webhook's org
 * resolver (Twilio tells us the `To` number, we map it back to the tenant).
 * Null when no org has claimed that number.
 */
export async function orgForTwilioNumber(
  admin: SupabaseClient<Database>,
  e164: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("org_integrations")
    .select("org_id")
    .eq("provider", TWILIO_PROVIDER)
    .filter("config->>phoneNumber", "eq", e164)
    .maybeSingle()
  if (error) {
    console.warn("[twilio] number → org lookup failed:", error.message)
    return null
  }
  return data?.org_id ?? null
}
