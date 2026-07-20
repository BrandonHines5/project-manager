import { Resend } from "resend"
import { logCommunication, type CommLogContext } from "@/lib/comms/log"
import { graphConfigured, sendGraphMail } from "@/lib/comms/graph"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getOrgIntegration, resolveOrgForProfile } from "@/lib/integrations/org"
import { LEGACY_ORG_ID } from "@/lib/org"

/** org_integrations provider slug for the per-org Resend email identity. */
const RESEND_PROVIDER = "resend"

type ResendConfig = {
  /** Resend API key for this org, or null when email isn't connected. */
  apiKey: string | null
  /** Verified From address (e.g. "hello@builder.com"), or null. */
  from: string | null
  /** Optional default display name for the From line, or null. */
  fromName: string | null
}

/**
 * Whether the PLATFORM Resend account is wired up — one master key
 * (`RESEND_PLATFORM_API_KEY`) plus a shared verified sending domain
 * (`PLATFORM_EMAIL_DOMAIN`, e.g. "mail.buildfox.ai"). When set, every builder
 * org gets keyless email out of the box (no API key, no DNS): it sends from a
 * per-org address on that domain.
 */
export function platformEmailConfigured(): boolean {
  return Boolean(
    process.env.RESEND_PLATFORM_API_KEY && process.env.PLATFORM_EMAIL_DOMAIN
  )
}

/** Sanitize an org slug into a safe email localpart, or null if empty. */
function sanitizeLocalpart(slug: string): string | null {
  const lp = slug
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/^[.-]+|[.-]+$/g, "")
  return lp || null
}

/**
 * The per-org platform sending address (`{slug}@{PLATFORM_EMAIL_DOMAIN}`), or
 * null when the platform domain isn't set or the slug yields no usable
 * localpart. Deterministic from the slug — there's no provisioning step, so a
 * builder's email works the moment their org exists.
 */
export function platformSenderAddress(
  slug: string | null | undefined
): string | null {
  const domain = process.env.PLATFORM_EMAIL_DOMAIN
  if (!domain || !slug) return null
  const lp = sanitizeLocalpart(slug)
  return lp ? `${lp}@${domain}` : null
}

/**
 * Platform-managed Resend identity for a non-legacy org: the platform master
 * key + the org's per-org address on the shared domain, presenting under the
 * org's name. Null when the platform isn't configured or the org has no usable
 * slug.
 */
async function resolvePlatformResendConfig(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  orgId: string
): Promise<ResendConfig | null> {
  const key = process.env.RESEND_PLATFORM_API_KEY
  if (!key) return null
  const { data: org, error } = await admin
    .from("organizations")
    .select("slug, name")
    .eq("id", orgId)
    .maybeSingle()
  if (error || !org) return null
  const from = platformSenderAddress(org.slug)
  if (!from) return null
  return { apiKey: key, from, fromName: org.name ?? null }
}

/**
 * Per-org Resend credentials (B4), the email analogue of resolveQuoConfig.
 * Resolution order:
 *  1. LEGACY org (or unresolved bridge send) → env `RESEND_API_KEY` /
 *     `RESEND_FROM_EMAIL` (the pre-multi-tenant Hines identity).
 *  2. A non-legacy org's OWN Resend key (`org_integrations` 'resend', a
 *     bring-your-own advanced override) → used verbatim when complete.
 *  3. Otherwise PLATFORM-MANAGED (the default, keyless): the platform Resend
 *     account sends from `{slug}@{PLATFORM_EMAIL_DOMAIN}` — a builder org has
 *     working email with zero setup and never enters a key.
 *  4. None of the above → "email not connected" (fail closed — never borrows
 *     Hines' From address).
 *
 * Fails closed for non-legacy orgs: getOrgIntegration THROWS on a decrypt
 * failure (a misconfigured master key), which must never silently degrade to
 * another tenant's key.
 */
async function resolveResendConfig(
  orgId: string | null | undefined
): Promise<ResendConfig> {
  let apiKey: string | null = null
  let from: string | null = null
  let fromName: string | null = null

  const admin = createSupabaseAdminClient()
  if (admin && orgId) {
    try {
      const integ = await getOrgIntegration(admin, orgId, RESEND_PROVIDER)
      if (integ && integ.enabled) {
        const k = integ.secrets?.apiKey
        const f = integ.config?.fromEmail
        const n = integ.config?.fromName
        apiKey = typeof k === "string" && k ? k : null
        from = typeof f === "string" && f ? f : null
        fromName = typeof n === "string" && n ? n : null
      }
    } catch (e) {
      console.error(
        "[email] org integration read failed:",
        e instanceof Error ? e.message : e
      )
      // A non-legacy org must NOT fall through to Hines' env credentials.
      if (orgId !== LEGACY_ORG_ID) {
        return { apiKey: null, from: null, fromName: null }
      }
    }
  }

  // 1. Legacy (or unresolved single-tenant) org: env is the source of truth.
  if (!orgId || orgId === LEGACY_ORG_ID) {
    apiKey = apiKey ?? process.env.RESEND_API_KEY ?? null
    from = from ?? process.env.RESEND_FROM_EMAIL ?? null
    return { apiKey, from, fromName }
  }

  // 2. Non-legacy org with its OWN complete Resend identity (advanced override).
  if (apiKey && from) return { apiKey, from, fromName }

  // 3. Default keyless path: platform-managed email.
  if (admin && platformEmailConfigured()) {
    const platform = await resolvePlatformResendConfig(admin, orgId)
    if (platform) return platform
  }

  // 4. Nothing usable — email isn't connected for this org.
  return { apiKey: null, from: null, fromName: null }
}

/**
 * Which org's email identity a send belongs to, resolved admin-side (send
 * paths have no session). Priority mirrors sendQuoSms plus the project/company
 * fallback logCommunication uses, so counterparty sends need zero call-site
 * changes: explicit `orgId` → `log.org_id` → the acting staffer's membership →
 * the attributed project's org → the attributed company's org. `failed` marks
 * a query ERROR so the caller fails closed (a hiccup must never borrow Hines'
 * env identity); a genuine miss is `orgId` null / `failed` false (the
 * single-tenant bridge → legacy env).
 */
async function resolveEmailOrg(opts: {
  orgId?: string | null
  log?: CommLogContext
}): Promise<{ orgId: string | null; failed: boolean }> {
  if (opts.orgId) return { orgId: opts.orgId, failed: false }
  const log = opts.log
  if (log?.org_id) return { orgId: log.org_id, failed: false }

  if (log?.sent_by) {
    const r = await resolveOrgForProfile(log.sent_by)
    if (r.failed) return { orgId: null, failed: true }
    if (r.orgId) return { orgId: r.orgId, failed: false }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { orgId: null, failed: false }
  if (log?.project_id) {
    const { data, error } = await admin
      .from("projects")
      .select("org_id")
      .eq("id", log.project_id)
      .maybeSingle()
    if (error) return { orgId: null, failed: true }
    if (data?.org_id) return { orgId: data.org_id, failed: false }
  }
  if (log?.company_id) {
    const { data, error } = await admin
      .from("companies")
      .select("org_id")
      .eq("id", log.company_id)
      .maybeSingle()
    if (error) return { orgId: null, failed: true }
    if (data?.org_id) return { orgId: data.org_id, failed: false }
  }
  return { orgId: null, failed: false }
}

/**
 * Sends a transactional email. Two transports, tried in order:
 *
 *  1. Microsoft Graph — Hines' Microsoft 365 tenant (a single-tenant app), so
 *     it serves the LEGACY org only. When the MS_* env vars are set and a
 *     sender mailbox resolves (the acting staff user's own address via
 *     `log.sent_by`, or MS_SYSTEM_MAILBOX for legacy cron/system mail), the
 *     email goes out from the user's REAL mailbox, lands in their Sent Items,
 *     and replies come back to their inbox — where the Outlook sync cron picks
 *     both up. Logged with the message's internetMessageId so the sync dedups
 *     onto the same row instead of double-posting the feed. The shared system
 *     mailbox is Hines' identity, so it's gated to the legacy/bridge org.
 *
 *  2. Resend — per-org: the From identity comes from resolveResendConfig —
 *     the legacy env identity for Hines, a builder's own key if it set one,
 *     else PLATFORM-MANAGED (the platform Resend account sending from the
 *     org's `{slug}@{PLATFORM_EMAIL_DOMAIN}` address — keyless, zero setup). An
 *     org with no usable identity does NOT send (fail closed) rather than going
 *     out from Hines' address. The org is resolved from `opts.orgId` →
 *     `log.org_id` → the staffer's membership → project/company. Project-scoped
 *     sends default their Reply-To to the comms plus-tag inbox so replies are
 *     still captured.
 *
 * Graceful no-op when neither transport is configured, so dev/preview
 * environments never break.
 */
export async function sendEmail(opts: {
  to: string | string[]
  cc?: string | string[]
  // Optional Reply-To. When the recipient hits "Reply" their response goes here
  // instead of the (often send-only) From address. Omitted callers are unaffected.
  replyTo?: string | string[]
  subject: string
  text: string
  html?: string
  // Which org's email identity sends this. Falls back to log.org_id, then the
  // acting staffer's membership, then the attributed project/company — so most
  // call sites need not pass it (mirrors sendQuoSms).
  orgId?: string | null
  // Optional sender display name. When set, the Resend "from" keeps its
  // verified sending address but presents under this name (e.g. an MJV job's
  // PO email shows "MJV Building Group" instead of the default house brand).
  // No effect on the Graph transport, which always sends from — and presents
  // as — the acting staffer's own mailbox.
  fromName?: string
  // Optional file attachments. `content` is base64-encoded bytes — the shape
  // both Resend and Graph accept. Existing callers that omit this are unaffected.
  attachments?: { filename: string; content: string }[]
  // Counterparty-facing sends pass this so the email lands in the project's
  // Communications feed. Staff-internal mail (digests, alerts) omits it and
  // is never logged.
  log?: CommLogContext
}): Promise<{ sent: boolean; reason?: string }> {
  const toList = Array.isArray(opts.to) ? opts.to : [opts.to]
  const ccList = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : undefined
  // Every outbound recipient belongs in the communications audit — CC'd
  // addresses (e.g. a sub's insurance agent) included, marked as such.
  const logToAddress = ccList?.length
    ? `${toList.join(", ")} (cc: ${ccList.join(", ")})`
    : toList.join(", ")
  const replyToList = opts.replyTo
    ? Array.isArray(opts.replyTo)
      ? opts.replyTo
      : [opts.replyTo]
    : undefined

  // Resolve which org's identity this send belongs to. Hines' shared
  // infrastructure — the MS Graph tenant's system mailbox and the env Resend
  // credentials — may serve only the LEGACY org (or a fully-unattributed
  // bridge send). A resolution ERROR fails closed: an unknown org never
  // counts as legacy, so it can't borrow Hines' identity.
  const orgResolution = await resolveEmailOrg(opts)
  const orgId = orgResolution.orgId
  const canUseSharedInfra =
    !orgResolution.failed && (!orgId || orgId === LEGACY_ORG_ID)

  // ── Transport 1: the sender's real Microsoft mailbox ──────────────────
  if (graphConfigured()) {
    const fromMailbox = await resolveSenderMailbox(
      opts.log?.sent_by,
      canUseSharedInfra
    )
    if (fromMailbox) {
      const g = await sendGraphMail({
        fromMailbox,
        to: toList,
        cc: ccList,
        // No plus-tag Reply-To here on purpose: replies should go to the
        // sender's own inbox, where the Outlook sync captures them.
        replyTo: replyToList,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        attachments: opts.attachments,
      })
      if (g.sent) {
        console.log(
          `[sendEmail] sent "${opts.subject}" via Outlook (${toList.length} recipient(s))`
        )
        if (opts.log) {
          await logCommunication({
            channel: "email",
            direction: "outbound",
            // Prefer the resolved org so a company-only/unattributed send still
            // records the right org instead of leaning on the bridge default.
            org_id: opts.log.org_id ?? orgId ?? undefined,
            project_id: opts.log.project_id,
            company_id: opts.log.company_id,
            profile_id: opts.log.profile_id,
            sent_by: opts.log.sent_by,
            from_address: fromMailbox,
            to_address: logToAddress,
            counterparty_name: opts.log.counterparty_name,
            subject: opts.subject,
            body: opts.text,
            // 'outlook' + internetMessageId is exactly what the sync cron
            // upserts on — so when this message shows up in Sent Items,
            // it merges into this row instead of duplicating.
            source: "outlook",
            source_kind: opts.log.kind,
            provider_id: g.internetMessageId ?? null,
          })
        }
        return { sent: true }
      }
      console.warn(
        `[sendEmail] Graph send failed (${g.reason}) — falling back to Resend`
      )
    }
  }

  // ── Transport 2: Resend (per-org) ─────────────────────────────────────
  // A non-legacy org whose org couldn't be resolved (a query error) must
  // never fall back to Hines' env credentials — fail closed like sendQuoSms.
  if (orgResolution.failed) {
    console.warn(
      `[sendEmail] skipped "${opts.subject}" — couldn't resolve the sending org (fail-closed)`
    )
    return { sent: false, reason: "Couldn't resolve the sending organization" }
  }
  const cfg = await resolveResendConfig(orgId)
  const key = cfg.apiKey
  const from = cfg.from
  // One-line, non-sensitive breadcrumb so prod logs show whether email is
  // even configured (we never print the key/recipients). A non-legacy org
  // with no 'resend' row lands here — email simply isn't connected for it yet.
  if (!key || !from) {
    console.warn(
      `[sendEmail] skipped "${opts.subject}" — email not connected for org ${
        orgId ?? "(legacy)"
      } (missing ${!key ? "API key" : ""}${!key && !from ? " + " : ""}${
        !from ? "From address" : ""
      })`
    )
    return { sent: false, reason: "Email is not connected for this organization" }
  }

  // Project-scoped sends default their Reply-To to the comms inbound
  // address with a project plus-tag (comms+p_<id>@…), so a client/sub reply
  // threads straight back into that job's Communications feed. Callers that
  // set an explicit replyTo (e.g. insurance, utilities) are untouched.
  let replyTo = opts.replyTo
  if (!replyTo && opts.log?.project_id) {
    const inbound = process.env.COMMS_INBOUND_EMAIL
    const at = inbound?.indexOf("@") ?? -1
    if (inbound && at > 0) {
      replyTo = `${inbound.slice(0, at)}+p_${opts.log.project_id}${inbound.slice(at)}`
    }
  }

  // Per-call fromName (e.g. an MJV job's PO email) wins; else the org's
  // configured default display name; else the bare verified address.
  const effectiveName = opts.fromName ?? cfg.fromName ?? null
  const fromLine = effectiveName ? applyFromName(from, effectiveName) : from

  const resend = new Resend(key)
  try {
    const { data, error } = await resend.emails.send({
      from: fromLine,
      to: opts.to,
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      ...(opts.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
    })
    if (error) {
      console.error("Resend send error:", error)
      return { sent: false, reason: error.message }
    }
    console.log(
      `[sendEmail] sent "${opts.subject}" to ${toList.length} recipient(s)`
    )
    if (opts.log) {
      await logCommunication({
        channel: "email",
        direction: "outbound",
        org_id: opts.log.org_id ?? orgId ?? undefined,
        project_id: opts.log.project_id,
        company_id: opts.log.company_id,
        profile_id: opts.log.profile_id,
        sent_by: opts.log.sent_by,
        from_address: fromLine,
        to_address: logToAddress,
        counterparty_name: opts.log.counterparty_name,
        subject: opts.subject,
        body: opts.text,
        source: "app",
        source_kind: opts.log.kind,
        provider_id: data?.id ?? null,
      })
    }
    return { sent: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("Resend exception:", msg)
    return { sent: false, reason: msg }
  }
}

/**
 * Which mailbox a send goes out from: the acting staff user's own address
 * (via log.sent_by → profiles.email) so the thread lives in THEIR Outlook;
 * otherwise the shared system mailbox (crons, token-page notifications).
 * Null = no Graph identity → caller falls back to Resend.
 *
 * A staffer's own mailbox is their identity regardless of org, but the shared
 * MS_SYSTEM_MAILBOX is Hines' — so it's offered only when `allowSystemMailbox`
 * is set (the legacy/bridge org). A non-legacy org's system-level send skips
 * Graph entirely and goes out through that org's own Resend identity.
 */
async function resolveSenderMailbox(
  sentBy: string | null | undefined,
  allowSystemMailbox: boolean
): Promise<string | null> {
  if (sentBy) {
    try {
      const admin = createSupabaseAdminClient()
      if (admin) {
        const { data } = await admin
          .from("profiles")
          .select("email, role")
          .eq("id", sentBy)
          .maybeSingle()
        if (data?.role === "staff" && data.email) return data.email
      }
    } catch {
      // fall through to the system mailbox
    }
  }
  return allowSystemMailbox ? process.env.MS_SYSTEM_MAILBOX || null : null
}

/**
 * Rebuild a Resend "from" so it presents under `name` while keeping the
 * verified sending address (SPF/DKIM are tied to the address, not the display
 * name, so this is deliverability-safe). Accepts the env value in either
 * `"Name <addr>"` or bare `"addr"` form. Strips line breaks (header
 * injection), then wraps the display name in an RFC 5322 quoted-string so any
 * specials in it (comma, semicolon, parentheses) can't be misread as an
 * address list — escaping embedded quotes/backslashes. Falls back to the
 * original `from` if nothing usable remains.
 */
function applyFromName(from: string, name: string): string {
  const match = from.match(/<([^>]+)>/)
  const address = (match ? match[1] : from).trim()
  const display = name.replace(/[\r\n]/g, "").trim()
  return display && address
    ? `"${display.replace(/["\\]/g, "\\$&")}" <${address}>`
    : from
}

export function appUrl(path: string = "/"): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"
  const normalized = base.startsWith("http") ? base : `https://${base}`
  return new URL(path, normalized).toString()
}
