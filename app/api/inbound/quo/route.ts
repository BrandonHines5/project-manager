import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { verifyQuoSignature } from "@/lib/comms/quo-verify"
import { matchCounterparty, scopeMatchToOrg, type MatchResult } from "@/lib/comms/match"
import { notifyStaffOfInbound } from "@/lib/comms/notify"
import { listOrgIntegrationSecrets } from "@/lib/integrations/org"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Quo (OpenPhone) webhook — captures EVERY text and call on the business
 * number(s), both directions, including texts PMs send from the Quo mobile
 * app that never touch this codebase. Events handled:
 *
 *  - message.received   → inbound SMS (+ staff bell notification)
 *  - message.delivered  → outbound SMS. App-sent texts were already logged
 *    at send time with the same (source='quo', provider_id), so the insert
 *    is ON CONFLICT DO NOTHING — only Quo-app sends create new rows.
 *  - call.completed     → call row (direction, duration, voicemail link)
 *  - call.recording.completed → merges the recording URL onto the call row
 *
 * Always 200 after signature verification (OpenPhone retries on non-2xx and
 * a poison event must not retry forever) — insurance-webhook convention.
 *
 * Multi-workspace: one endpoint serves EVERY OpenPhone workspace. The legacy
 * env `QUO_WEBHOOK_SECRET` (Hines' workspace) is tried first — zero change
 * for the common case — then each org's stored signing secret (builder orgs
 * that connected their own OpenPhone account). Whichever org's secret
 * verifies the event tells us, cryptographically, which tenant it belongs
 * to: that org is stamped directly and the counterparty match is scoped to
 * it, so a bring-your-own workspace can never file traffic onto another
 * tenant. Env-verified events keep the legacy best-effort org resolution.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sigHeader = req.headers.get("openphone-signature")

  const admin = createSupabaseAdminClient()
  if (!admin) {
    console.error("[quo webhook] admin client unavailable")
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const envSecret = process.env.QUO_WEBHOOK_SECRET
  // Which org's stored secret verified the event; null = the legacy env
  // workspace (or an org that pasted the same secret — impossible to mint
  // by accident, and env-first only ever widens to legacy behavior).
  let verifiedOrgId: string | null = null
  let verified = envSecret
    ? verifyQuoSignature(rawBody, sigHeader, envSecret)
    : false
  if (!verified) {
    try {
      for (const row of await listOrgIntegrationSecrets(admin, "quo")) {
        const secret = row.secrets.webhookSecret
        if (typeof secret !== "string" || !secret) continue
        if (verifyQuoSignature(rawBody, sigHeader, secret)) {
          verified = true
          verifiedOrgId = row.org_id
          break
        }
      }
    } catch (e) {
      // Can't read the candidate secrets — 500 so OpenPhone retries rather
      // than dropping a legitimate event on a transient DB error.
      console.error(
        "[quo webhook] org secret lookup failed:",
        e instanceof Error ? e.message : e
      )
      return NextResponse.json({ error: "Verification unavailable" }, { status: 500 })
    }
  }
  if (!verified) {
    if (!envSecret) console.error("[quo webhook] QUO_WEBHOOK_SECRET not configured")
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let event: QuoEvent
  try {
    event = JSON.parse(rawBody) as QuoEvent
  } catch {
    return NextResponse.json({ ok: true, skipped: "unparseable" })
  }
  const type = event?.type ?? ""
  const obj = event?.data?.object
  if (!obj?.id) return NextResponse.json({ ok: true, skipped: type || "no-object" })

  try {
    switch (type) {
      case "message.received":
      case "message.delivered": {
        const inbound = obj.direction === "incoming"
        const counterpartyNumber = inbound ? obj.from : firstTo(obj.to)
        // Which staffer owns the Quo number this text went through — powers
        // per-user attribution for texts typed directly in the Quo app (app-sent
        // texts already carry sent_by and win the ON CONFLICT below).
        const staffProfileId = await scopeStaffToOrg(
          admin,
          await staffProfileForQuoNumber(
            admin,
            obj.phoneNumberId,
            inbound ? firstTo(obj.to) : (obj.from ?? null)
          ),
          verifiedOrgId
        )
        const { match, orgId } = await attributeForOrg(
          admin,
          verifiedOrgId,
          staffProfileId,
          await matchCounterparty(admin, { phone: counterpartyNumber })
        )
        const { error } = await admin.from("communications").upsert(
          {
            channel: "sms",
            direction: inbound ? "inbound" : "outbound",
            // Stamp org when we can resolve it (the line owner's org, or the
            // matched project/company); a fully unattributed text — shared
            // line, unknown number — falls to the communications bridge
            // default (Hines), which is why that default is the last one
            // still standing.
            ...(orgId ? { org_id: orgId } : {}),
            // Quo texts are never queued for manual placement — they always
            // land in the global Communications log, auto-filed to a job only
            // when the matcher is confident (project_id set below). A shared
            // conversation can span jobs, so an unmatched text just stays
            // global and searchable; staff can optionally file it later.
            status: "logged",
            project_id: match.project_id,
            company_id: match.company_id,
            profile_id: match.profile_id,
            // Outbound = the staffer sent it, so attribute them as sender.
            // Inbound = they only received it; the line owner lives in meta.
            sent_by: inbound ? null : staffProfileId,
            from_address: obj.from ?? null,
            to_address: firstTo(obj.to),
            counterparty_name: match.counterparty_name,
            body: obj.body ?? obj.text ?? "",
            source: "quo",
            source_kind: type,
            provider_id: obj.id,
            occurred_at: obj.createdAt ?? event.createdAt ?? new Date().toISOString(),
            meta: {
              userId: obj.userId ?? null,
              phoneNumberId: obj.phoneNumberId ?? null,
              conversationId: obj.conversationId ?? null,
              quoStaffProfileId: staffProfileId,
            },
          },
          // App-sent texts already hold this (source, provider_id) — keep
          // their richer attribution (sent_by, kind) and skip the insert.
          { onConflict: "source,provider_id", ignoreDuplicates: true }
        )
        if (error) throw new Error(error.message)
        if (inbound) {
          await notifyStaffOfInbound({
            kind: "sms",
            fromName: match.counterparty_name ?? obj.from ?? "Unknown number",
            preview: obj.body ?? obj.text ?? "",
            projectId: match.project_id,
            projectName: await projectName(admin, match.project_id),
            // Ring only the resolved org's staff — the verified org, or the
            // legacy path's best-effort resolution (which also stamps the
            // row, so the bell and the row's visibility agree). Null = truly
            // unattributed → the legacy all-staff fan-out.
            orgId,
          })
        }
        return NextResponse.json({ ok: true })
      }

      case "call.completed": {
        const inbound = obj.direction === "incoming"
        const counterpartyNumber = inbound ? obj.from : firstTo(obj.to)
        const staffProfileId = await scopeStaffToOrg(
          admin,
          await staffProfileForQuoNumber(
            admin,
            obj.phoneNumberId,
            inbound ? firstTo(obj.to) : (obj.from ?? null)
          ),
          verifiedOrgId
        )
        const { match, orgId } = await attributeForOrg(
          admin,
          verifiedOrgId,
          staffProfileId,
          await matchCounterparty(admin, { phone: counterpartyNumber })
        )
        const durationSeconds =
          obj.answeredAt && obj.completedAt
            ? Math.max(
                0,
                Math.round(
                  (Date.parse(obj.completedAt) - Date.parse(obj.answeredAt)) / 1000
                )
              )
            : null
        const voicemailUrl = obj.voicemail?.url ?? null
        const missed = !obj.answeredAt
        const { error } = await admin.from("communications").upsert(
          {
            channel: "call",
            direction: inbound ? "inbound" : "outbound",
            // Org stamped when resolvable (see the message case); shared-line
            // calls fall to the communications bridge default.
            ...(orgId ? { org_id: orgId } : {}),
            // Same as texts: calls are never queued for manual placement. They
            // stay in the global log, auto-filed to a job only when confident.
            status: "logged",
            project_id: match.project_id,
            company_id: match.company_id,
            profile_id: match.profile_id,
            // Outbound call = the staffer dialed it → attribute as sender.
            sent_by: inbound ? null : staffProfileId,
            from_address: obj.from ?? null,
            to_address: firstTo(obj.to),
            counterparty_name: match.counterparty_name,
            body: voicemailUrl
              ? "Voicemail"
              : missed
                ? "Missed call"
                : "Call",
            source: "quo",
            source_kind: type,
            provider_id: obj.id,
            call_duration_seconds: durationSeconds,
            call_recording_url: voicemailUrl,
            occurred_at: obj.createdAt ?? event.createdAt ?? new Date().toISOString(),
            meta: {
              userId: obj.userId ?? null,
              phoneNumberId: obj.phoneNumberId ?? null,
              conversationId: obj.conversationId ?? null,
              quoStaffProfileId: staffProfileId,
              missed,
              voicemail: Boolean(voicemailUrl),
            },
          },
          { onConflict: "source,provider_id", ignoreDuplicates: true }
        )
        if (error) throw new Error(error.message)
        if (inbound) {
          await notifyStaffOfInbound({
            kind: "call",
            fromName: match.counterparty_name ?? obj.from ?? "Unknown number",
            preview: voicemailUrl
              ? "Left a voicemail"
              : missed
                ? "Missed call"
                : durationSeconds
                  ? `Call, ${Math.round(durationSeconds / 60)} min`
                  : "Call",
            projectId: match.project_id,
            projectName: await projectName(admin, match.project_id),
            // Ring only the resolved org's staff — the verified org, or the
            // legacy path's best-effort resolution (which also stamps the
            // row, so the bell and the row's visibility agree). Null = truly
            // unattributed → the legacy all-staff fan-out.
            orgId,
          })
        }
        return NextResponse.json({ ok: true })
      }

      case "call.recording.completed": {
        // Recording arrives after call.completed; merge the URL onto the
        // existing call row. media shape: [{ url, type }]
        const url = obj.media?.[0]?.url ?? null
        if (!url) return NextResponse.json({ ok: true, skipped: "no-recording-url" })
        const { error } = await admin
          .from("communications")
          .update({ call_recording_url: url })
          .eq("source", "quo")
          .eq("provider_id", obj.id)
        if (error) throw new Error(error.message)
        return NextResponse.json({ ok: true })
      }

      default:
        return NextResponse.json({ ok: true, skipped: type })
    }
  } catch (e) {
    // Log and 200 — a bad row must not put OpenPhone into a retry loop.
    console.error(
      `[quo webhook] ${type} processing failed:`,
      e instanceof Error ? e.message : e
    )
    return NextResponse.json({ ok: true, stored: false })
  }
}

type QuoEvent = {
  id?: string
  type?: string
  createdAt?: string
  data?: {
    object?: {
      id?: string
      from?: string
      to?: string | string[]
      direction?: "incoming" | "outgoing"
      body?: string
      text?: string
      createdAt?: string
      answeredAt?: string | null
      completedAt?: string | null
      voicemail?: { url?: string; duration?: number; type?: string } | null
      media?: { url?: string; type?: string }[]
      userId?: string
      phoneNumberId?: string
      conversationId?: string
    }
  }
}

function firstTo(to: string | string[] | undefined): string | null {
  if (!to) return null
  return Array.isArray(to) ? (to[0] ?? null) : to
}

/**
 * The staff profile that owns the business-side Quo number an event went
 * through — matched first on the stable phone-number id, then its E.164.
 * Returns null when the number isn't assigned to anyone (the shared line, or
 * an unmapped number), which just leaves the row unattributed.
 */
async function staffProfileForQuoNumber(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  phoneNumberId: string | undefined,
  e164: string | null
): Promise<string | null> {
  if (phoneNumberId) {
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .eq("quo_phone_number_id", phoneNumberId)
      .maybeSingle()
    // Log — a query failure must stay distinguishable from a genuine no-match
    // (both fall through to null), else attribution vanishes with no signal.
    if (error) {
      console.warn("[quo webhook] phoneNumberId → profile lookup failed:", error.message)
    }
    if (data?.id) return data.id
  }
  if (e164) {
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .eq("quo_phone_number", e164)
      .maybeSingle()
    if (error) {
      console.warn("[quo webhook] e164 → profile lookup failed:", error.message)
    }
    if (data?.id) return data.id
  }
  return null
}

/**
 * For org-verified events, a staff-number match must belong to that org —
 * staffProfileForQuoNumber matches quo numbers across ALL tenants (fine for
 * the legacy single-workspace path), so a stale number reassigned between
 * workspaces (or a forged event signed with the org's own secret) could
 * otherwise stamp another tenant's profile into this org's rows via sent_by /
 * meta.quoStaffProfileId. A lookup ERROR fails closed to null (drops
 * attribution, keeps the event). Legacy env-verified events pass through
 * unchanged.
 */
async function scopeStaffToOrg(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  staffProfileId: string | null,
  verifiedOrgId: string | null
): Promise<string | null> {
  if (!staffProfileId || !verifiedOrgId) return staffProfileId
  const { data, error } = await admin
    .from("organization_members")
    .select("profile_id")
    .eq("org_id", verifiedOrgId)
    .eq("profile_id", staffProfileId)
    .maybeSingle()
  if (error) {
    console.warn("[quo webhook] staff org-scope lookup failed:", error.message)
    return null
  }
  return data ? staffProfileId : null
}

/**
 * Tenant attribution for one event. When an ORG'S OWN signing secret verified
 * it, that org is authoritative — stamp it and drop any attribution the
 * global matcher resolved into another tenant (a scope-lookup failure keeps
 * the event but drops links; this route's always-200 contract can't retry
 * without losing it). Env-verified (legacy workspace) events keep the
 * best-effort resolveInboundOrg heuristics, unchanged.
 */
async function attributeForOrg(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  verifiedOrgId: string | null,
  staffProfileId: string | null,
  match: MatchResult
): Promise<{ match: MatchResult; orgId: string | null }> {
  if (verifiedOrgId) {
    const scoped = await scopeMatchToOrg(admin, match, verifiedOrgId)
    return { match: scoped.match, orgId: verifiedOrgId }
  }
  return { match, orgId: await resolveInboundOrg(admin, staffProfileId, match) }
}

/**
 * The org an inbound Quo event belongs to, best-effort (B4): the line
 * owner's org first (per-user Quo numbers make this the strongest signal),
 * then the matched project's, then the matched company's. Null when nothing
 * resolves — a shared-line text from an unknown number — and the row falls
 * to the communications bridge default.
 */
async function resolveInboundOrg(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  staffProfileId: string | null,
  match: { project_id: string | null; company_id: string | null }
): Promise<string | null> {
  // Each lookup logs on error so an attribution miss caused by a query
  // failure stays distinguishable from a genuine no-match (both return null),
  // matching staffProfileForQuoNumber's convention.
  if (staffProfileId) {
    const { data, error } = await admin
      .from("organization_members")
      .select("org_id")
      .eq("profile_id", staffProfileId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) console.warn("[quo webhook] staff → org lookup failed:", error.message)
    if (data?.org_id) return data.org_id
  }
  if (match.project_id) {
    const { data, error } = await admin
      .from("projects")
      .select("org_id")
      .eq("id", match.project_id)
      .maybeSingle()
    if (error) console.warn("[quo webhook] project → org lookup failed:", error.message)
    if (data?.org_id) return data.org_id
  }
  if (match.company_id) {
    const { data, error } = await admin
      .from("companies")
      .select("org_id")
      .eq("id", match.company_id)
      .maybeSingle()
    if (error) console.warn("[quo webhook] company → org lookup failed:", error.message)
    if (data?.org_id) return data.org_id
  }
  return null
}

async function projectName(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  projectId: string | null
): Promise<string | null> {
  if (!projectId) return null
  const { data } = await admin
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle()
  return data?.name ?? null
}
