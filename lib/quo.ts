import "server-only"
import { logCommunication, type CommLogContext } from "@/lib/comms/log"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getOrgIntegration } from "@/lib/integrations/org"
import { LEGACY_ORG_ID } from "@/lib/org"

/** org_integrations provider slug for Quo/OpenPhone. */
const QUO_PROVIDER = "quo"

export type QuoConfig = {
  /** OpenPhone API key for this org, or null when not connected. */
  apiKey: string | null
  /** Shared workspace from-number (Quo id or E.164), or null. */
  sharedFrom: string | null
}

/**
 * Per-org Quo credentials (B4): `apiKey` from the org's `org_integrations`
 * 'quo' secrets envelope, `sharedFrom` from its config. Env
 * `QUO_API_KEY` / `QUO_FROM_NUMBER` are the fallback for the LEGACY org
 * ONLY (the pre-multi-tenant Hines line) — every other org must carry its
 * own row, so a missing config reads as "Quo not connected", never as
 * "borrow Hines' number". A null orgId (org couldn't be resolved) is the
 * single-tenant bridge state and also falls back to legacy env.
 *
 * Fails closed for non-legacy orgs: getOrgIntegration THROWS on a decrypt
 * failure (a misconfigured master key), which must never silently degrade
 * to the env key of another tenant.
 */
export async function resolveQuoConfig(
  orgId: string | null | undefined
): Promise<QuoConfig> {
  let apiKey: string | null = null
  let sharedFrom: string | null = null

  const admin = createSupabaseAdminClient()
  if (admin && orgId) {
    try {
      const integ = await getOrgIntegration(admin, orgId, QUO_PROVIDER)
      if (integ && integ.enabled) {
        const secretKey = integ.secrets?.apiKey
        const cfgFrom = integ.config?.sharedFromNumber
        apiKey = typeof secretKey === "string" && secretKey ? secretKey : null
        sharedFrom = typeof cfgFrom === "string" && cfgFrom ? cfgFrom : null
      }
    } catch (e) {
      console.error(
        "[quo] org integration read failed:",
        e instanceof Error ? e.message : e
      )
      // A non-legacy org must NOT fall through to Hines' env key.
      if (orgId !== LEGACY_ORG_ID) return { apiKey: null, sharedFrom: null }
    }
  }

  // Legacy (or unresolved single-tenant) org: env is the source of truth
  // until its org_integrations row is populated.
  if (!orgId || orgId === LEGACY_ORG_ID) {
    apiKey = apiKey ?? process.env.QUO_API_KEY ?? null
    sharedFrom = sharedFrom ?? process.env.QUO_FROM_NUMBER ?? null
  }
  return { apiKey, sharedFrom }
}

/**
 * The org a staffer belongs to, resolved admin-side (the send path has no
 * session). Earliest membership — one org per user today. `failed`
 * distinguishes a query ERROR (caller must fail closed — a transient hiccup
 * must never borrow Hines' env key) from a genuine no-membership (`orgId`
 * null, `failed` false — the single-tenant bridge).
 */
async function resolveOrgForProfile(
  profileId: string | null | undefined
): Promise<{ orgId: string | null; failed: boolean }> {
  if (!profileId) return { orgId: null, failed: false }
  const admin = createSupabaseAdminClient()
  if (!admin) return { orgId: null, failed: false }
  const { data, error } = await admin
    .from("organization_members")
    .select("org_id")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn("[quo] profile → org lookup failed:", error.message)
    return { orgId: null, failed: true }
  }
  return { orgId: data?.org_id ?? null, failed: false }
}

/**
 * Sends an SMS via Quo (built on OpenPhone — host is api.openphone.com).
 * Graceful no-op if the org's Quo API key is missing (and no usable `from`
 * resolves) so dev / preview environments don't break.
 *
 * Per-org (B4): the API key and shared from-number come from the org's
 * `org_integrations` 'quo' row (env fallback for the legacy Hines org). The
 * org is `opts.orgId` → `log.org_id` → the acting staffer's membership.
 *
 * Per-user sending: each text goes out from the ACTING staffer's own Quo
 * number when they have one, so the sub's reply — and any follow-up call —
 * comes back to that person, not a shared inbox. The number is resolved from
 * `senderProfileId` (or, if omitted, `log.sent_by`, which every call site
 * already sets to the staffer who initiated the send). A staffer with no Quo
 * number assigned falls back to the org's shared number. An explicit `from`
 * always wins.
 *
 * `from` / the org's shared number / a profile's stored number each accept
 * either a Quo phone number ID ("PN…") or an E.164 number ("+15555555555");
 * the Quo API takes either form.
 *
 * Auth header is `Authorization: <api-key>` (raw key, no `Bearer` prefix) —
 * that's what the Quo OpenAPI spec specifies for its apiKey security scheme.
 */
export async function sendQuoSms(opts: {
  to: string
  content: string
  // Overrides the sending number outright (Quo number id or E.164). When
  // unset, the number is resolved from senderProfileId / log.sent_by below.
  from?: string
  // The staffer this text is sent on behalf of — used to look up their Quo
  // number. Defaults to log.sent_by so no call site has to pass it twice.
  senderProfileId?: string | null
  // Which org's Quo account sends this. Falls back to log.org_id, then the
  // sender's membership — so most call sites need not pass it.
  orgId?: string | null
  // Counterparty-facing sends pass this so the text lands in the project's
  // Communications feed. Omitted → not logged.
  log?: CommLogContext
}): Promise<{ sent: boolean; reason?: string; providerId?: string }> {
  // Resolve the sending org, then its Quo credentials.
  const senderId = opts.senderProfileId ?? opts.log?.sent_by ?? null
  let orgId = opts.orgId ?? opts.log?.org_id ?? null
  if (!orgId && senderId) {
    const resolved = await resolveOrgForProfile(senderId)
    // A membership-lookup FAILURE must fail closed like the decrypt path — a
    // transient error must never let a non-legacy staffer's text bill Hines'
    // shared Quo account. A genuine no-membership stays the single-tenant
    // bridge (null → legacy env fallback in resolveQuoConfig).
    if (resolved.failed) {
      return {
        sent: false,
        reason: "Couldn't resolve the sending organization",
      }
    }
    orgId = resolved.orgId
  }
  const cfg = await resolveQuoConfig(orgId)
  const key = cfg.apiKey
  if (!key) {
    return { sent: false, reason: "Quo is not connected for this organization" }
  }

  // Resolve the sending number: explicit override → the acting staffer's own
  // Quo number → the org's shared default. Never throws; falls back on any miss.
  const from =
    opts.from ??
    (await resolveStaffQuoNumber(senderId)) ??
    cfg.sharedFrom ??
    undefined
  if (!from) {
    return {
      sent: false,
      reason:
        "No sending number — the org has no shared Quo number and the sender has none assigned",
    }
  }

  const to = normalizeE164(opts.to)
  if (!to) {
    return { sent: false, reason: `Invalid recipient phone number: ${opts.to}` }
  }
  const content = opts.content.trim()
  if (!content) {
    return { sent: false, reason: "Empty message content" }
  }
  if (content.length > 1600) {
    return { sent: false, reason: "Message exceeds 1600-character limit" }
  }

  try {
    const res = await fetch("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], content }),
      // Quo's send endpoint returns 202 Accepted as soon as the message is
      // queued, so a slow response means the upstream is stuck. Match the
      // 5s outbound timeout used by the dashboard integration so a stalled
      // Quo doesn't hold the server action open indefinitely.
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error(`Quo send failed (${res.status}):`, text)
      return { sent: false, reason: `Quo API ${res.status}: ${text || res.statusText}` }
    }
    // The 202 body carries the created message object; its id is our dedup
    // key against the message.delivered webhook (which logs source 'quo'
    // too, so the unique (source, provider_id) index merges the two).
    let providerId: string | undefined
    try {
      const json = (await res.json()) as { data?: { id?: string }; id?: string }
      providerId = json?.data?.id ?? json?.id ?? undefined
    } catch {
      // Body wasn't JSON — fine, we just log without a provider id.
    }
    if (opts.log) {
      await logCommunication({
        channel: "sms",
        direction: "outbound",
        // Fall back to the org we resolved to pick the Quo account — a manual
        // send to a raw number has no project/company for logCommunication to
        // derive org from, so without this the row would hit the bridge
        // default (Hines) even though it went out on another org's number.
        org_id: opts.log.org_id ?? orgId ?? undefined,
        project_id: opts.log.project_id,
        company_id: opts.log.company_id,
        profile_id: opts.log.profile_id,
        sent_by: opts.log.sent_by,
        from_address: from,
        to_address: to,
        counterparty_name: opts.log.counterparty_name,
        body: content,
        source: "quo",
        source_kind: opts.log.kind,
        provider_id: providerId ?? null,
      })
    }
    return { sent: true, providerId }
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      console.error("Quo send timed out after 5s")
      return { sent: false, reason: "Quo API request timed out" }
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error("Quo send exception:", msg)
    return { sent: false, reason: msg }
  }
}

/** One selectable Quo workspace number, for assigning to a team member. */
export type QuoPhoneNumber = {
  /** OpenPhone phone-number id ("PN…") — stored as the send `from`. */
  id: string
  /** E.164, e.g. "+15555550100". */
  number: string
  /** Workspace label, e.g. "Adam — Field". */
  name: string | null
}

/**
 * Lists the numbers in the org's Quo (OpenPhone) workspace so staff can map
 * each one to a person on the Team page. Returns [] (never throws) when the
 * org has no Quo key or the API is unreachable, so /team still renders
 * without Quo wired up.
 */
export async function listQuoPhoneNumbers(
  orgId: string | null | undefined
): Promise<QuoPhoneNumber[]> {
  const { apiKey: key } = await resolveQuoConfig(orgId)
  if (!key) return []
  try {
    const res = await fetch("https://api.openphone.com/v1/phone-numbers", {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      console.warn(`[quo] list phone numbers failed (${res.status})`)
      return []
    }
    const json = (await res.json()) as {
      data?: { id?: string; number?: string; name?: string | null }[]
    }
    return (json.data ?? [])
      .filter((n): n is { id: string; number: string; name?: string | null } =>
        Boolean(n?.id && n?.number)
      )
      .map((n) => ({ id: n.id, number: n.number, name: n.name ?? null }))
  } catch (e) {
    console.warn(
      "[quo] list phone numbers exception:",
      e instanceof Error ? e.message : String(e)
    )
    return []
  }
}

/**
 * The Quo number a staffer sends from — their stored phone-number id ("PN…")
 * when set, else its E.164, else null (caller falls back to the shared
 * QUO_FROM_NUMBER). Prefers the id because it's stable across number
 * re-labeling in the Quo workspace. Best-effort: a missing admin client or a
 * lookup error resolves to null rather than blocking the send.
 */
async function resolveStaffQuoNumber(
  profileId: string | null | undefined
): Promise<string | null> {
  if (!profileId) return null
  const admin = createSupabaseAdminClient()
  if (!admin) return null
  const { data, error } = await admin
    .from("profiles")
    .select("quo_phone_number_id, quo_phone_number")
    .eq("id", profileId)
    .maybeSingle()
  if (error) {
    console.warn("[quo] sender number lookup failed:", error.message)
    return null
  }
  return data?.quo_phone_number_id || data?.quo_phone_number || null
}

/**
 * Coerces a US-style phone number string into E.164. Accepts inputs like
 * "(555) 555-5555", "555-555-5555", "5555555555", "+15555555555". Returns
 * null if the input doesn't parse to a plausible E.164 number.
 */
export function normalizeE164(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\+[1-9]\d{1,14}$/.test(raw)) return raw
  const digits = raw.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}
