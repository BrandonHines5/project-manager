import { NextResponse } from "next/server"
import { Resend, type WebhookEventPayload } from "resend"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { matchCounterparty, type MatchResult } from "@/lib/comms/match"
import { notifyStaffOfInbound } from "@/lib/comms/notify"

type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>

/**
 * Resend inbound webhook for the Communications hub. Outbound app emails
 * that carry a project context set their Reply-To to
 * `comms+p_<project_id>@<inbound domain>` (see lib/email.ts), so when a
 * client or sub hits Reply, the response routes here, is attributed to the
 * project from the plus-tag (falling back to sender matching), and shows up
 * on the job's Communications tab.
 *
 * Separate endpoint + signing secret (COMMS_RESEND_WEBHOOK_SECRET) from the
 * insurance inbox so either can be rotated independently.
 *
 * Always answers 200 for verified events (Resend retries non-2xx and a
 * poison event must not loop) — same convention as /api/inbound/insurance.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Routing tag on the Reply-To local part: +p_<project> | +c_<company> |
// +o_<org> (works whatever COMMS_INBOUND_EMAIL's mailbox name is — comms@,
// replies@, …). With one shared From address this tag is the primary signal of
// which org/thread a reply belongs to.
const ROUTE_TAG_RE =
  /\+(p|c|o)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY
  const webhookSecret = process.env.COMMS_RESEND_WEBHOOK_SECRET
  if (!apiKey || !webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "RESEND_API_KEY / COMMS_RESEND_WEBHOOK_SECRET not configured" },
      { status: 500 }
    )
  }

  const payload = await req.text()
  const svixId = req.headers.get("svix-id")
  const svixTimestamp = req.headers.get("svix-timestamp")
  const svixSignature = req.headers.get("svix-signature")
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ ok: false, error: "missing signature" }, { status: 401 })
  }

  const resend = new Resend(apiKey)
  let event: WebhookEventPayload
  try {
    event = resend.webhooks.verify({
      payload,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret,
    })
  } catch {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 })
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ ok: true, skipped: event.type })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    console.error("[email-replies] admin client unavailable")
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 500 })
  }

  try {
    const email = event.data as unknown as {
      email_id: string
      from: string
      to: string | string[]
      subject?: string | null
      text?: string | null
      html?: string | null
      attachments?: unknown[]
    }
    const fromAddress = parseAddress(email.from)
    const toList = Array.isArray(email.to) ? email.to : [email.to]

    // Don't double-ingest mail meant for the insurance inbox — that
    // endpoint owns COI processing.
    const insuranceInbox = process.env.INSURANCE_INBOUND_EMAIL?.toLowerCase()
    if (
      insuranceInbox &&
      toList.some((t) => parseAddress(t).toLowerCase() === insuranceInbox)
    ) {
      return NextResponse.json({ ok: true, skipped: "insurance-inbox" })
    }

    // Parse the routing tag (+p_/+c_/+o_) — it beats sender matching.
    let tag: { kind: "p" | "c" | "o"; id: string } | null = null
    for (const t of toList) {
      const m = ROUTE_TAG_RE.exec(parseAddress(t))
      if (m) {
        tag = { kind: m[1].toLowerCase() as "p" | "c" | "o", id: m[2] }
        break
      }
    }

    const match = await matchCounterparty(admin, { email: fromAddress })

    // Resolve the owning org — the tag first (strongest; the From is a shared
    // mailbox that carries no tenant), then the matched counterparty's org.
    const route = await resolveReplyOrg(admin, tag, match)
    const orgId = route.orgId

    // Scope the (global) matcher result to the resolved org so a shared address
    // can't cross-file into another tenant's project/company/profile.
    const scoped = orgId ? await scopeMatchToOrg(admin, match, orgId) : match

    const projectId = route.projectId ?? scoped.project_id
    const companyId = route.companyId ?? scoped.company_id
    const status = projectId ? "logged" : scoped.status

    const bodyText =
      email.text?.trim() ||
      (email.html ? stripHtml(email.html) : "") ||
      "(no text body)"

    const { error } = await admin.from("communications").upsert(
      {
        channel: "email",
        direction: "inbound",
        // Stamp the resolved org so a builder's reply lands in THEIR feed, not
        // the communications bridge default (Hines). Null only when nothing
        // resolved — an untagged reply from an unknown address.
        ...(orgId ? { org_id: orgId } : {}),
        status,
        project_id: projectId,
        company_id: companyId,
        profile_id: scoped.profile_id,
        from_address: fromAddress,
        to_address: toList.map(parseAddress).join(", "),
        counterparty_name: scoped.counterparty_name ?? displayName(email.from),
        subject: email.subject ?? null,
        body: bodyText,
        source: "resend_inbound",
        source_kind: "email.received",
        provider_id: email.email_id,
        meta: { attachments: email.attachments?.length ?? 0 },
      },
      { onConflict: "source,provider_id", ignoreDuplicates: true }
    )
    if (error) throw new RetryableDbError(error.message)

    await notifyStaffOfInbound({
      kind: "email",
      fromName: scoped.counterparty_name ?? displayName(email.from),
      preview: email.subject || bodyText,
      projectId,
      projectName: projectId ? await projectName(admin, projectId) : null,
      // Fail CLOSED when the org is unresolved: with a shared inbound address,
      // a null org must NOT fall into notify's legacy all-staff path (that
      // would leak a reply's sender/subject to every tenant). The empty-string
      // signal makes notifyStaffOfInbound notify nobody. The message is still
      // logged for someone to find in the hub.
      orgId: orgId ?? "",
    })

    // Ids only in logs — addresses and subjects are PII.
    console.log(
      `[email-replies] email_id=${email.email_id} matched=${Boolean(projectId)} org=${Boolean(orgId)}`
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    // A transient DB failure (scope lookup or the write) is retryable — return
    // 503 so Resend redelivers (the upsert dedups on (source, provider_id), so
    // a retry is idempotent) rather than dropping/losing the reply.
    if (e instanceof RetryableDbError) {
      console.error("[email-replies] transient DB failure; requesting retry:", e.message)
      return NextResponse.json({ ok: false, error: "database unavailable" }, { status: 503 })
    }
    console.error(
      "[email-replies] processing failed:",
      e instanceof Error ? e.message : e
    )
    return NextResponse.json({ ok: true, stored: false })
  }
}

/**
 * The org that owns an inbound reply. The routing tag wins (the From is a
 * shared platform mailbox, so it can't identify the tenant): +p_ → the
 * project's org, +c_ → the company's org, +o_ → the org directly. With no
 * usable tag, fall back to the matched counterparty's project/company org.
 * Returns the tag's project/company too so we file to it even when the sender
 * match is ambiguous.
 */
async function resolveReplyOrg(
  admin: AdminClient,
  tag: { kind: "p" | "c" | "o"; id: string } | null,
  match: MatchResult
): Promise<{
  orgId: string | null
  projectId: string | null
  companyId: string | null
}> {
  if (tag?.kind === "p") {
    const { data } = await admin
      .from("projects")
      .select("id, org_id")
      .eq("id", tag.id)
      .maybeSingle()
    if (data) return { orgId: data.org_id, projectId: data.id, companyId: null }
  } else if (tag?.kind === "c") {
    const { data } = await admin
      .from("companies")
      .select("id, org_id")
      .eq("id", tag.id)
      .maybeSingle()
    if (data) return { orgId: data.org_id, projectId: null, companyId: data.id }
  } else if (tag?.kind === "o") {
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("id", tag.id)
      .maybeSingle()
    if (data) return { orgId: data.id, projectId: null, companyId: null }
  }
  // No usable tag — derive the org from the matched counterparty.
  if (match.project_id) {
    const { data } = await admin
      .from("projects")
      .select("org_id")
      .eq("id", match.project_id)
      .maybeSingle()
    if (data?.org_id) {
      return { orgId: data.org_id, projectId: null, companyId: null }
    }
  }
  if (match.company_id) {
    const { data } = await admin
      .from("companies")
      .select("org_id")
      .eq("id", match.company_id)
      .maybeSingle()
    if (data?.org_id) {
      return { orgId: data.org_id, projectId: null, companyId: null }
    }
  }
  return { orgId: null, projectId: null, companyId: null }
}

/**
 * Drops attribution that resolved into a different org than the one that owns
 * this reply — matchCounterparty is global (a counterparty address can exist in
 * several orgs), so a mismatched project/company/profile is discarded, keeping
 * the reply logged under the right tenant but unlinked.
 */
/** A transient DB failure (scope lookup OR the communications write) — the
 *  route returns a retryable 503 for these rather than dropping/losing the
 *  reply and 200-ing (no retry). Genuine no-match / poison rows still 200. */
class RetryableDbError extends Error {}

async function scopeMatchToOrg(
  admin: AdminClient,
  match: MatchResult,
  orgId: string
): Promise<MatchResult> {
  const unlinked: MatchResult = {
    ...match,
    project_id: null,
    company_id: null,
    profile_id: null,
  }
  if (match.project_id) {
    const { data, error } = await admin
      .from("projects")
      .select("org_id")
      .eq("id", match.project_id)
      .maybeSingle()
    if (error) throw new RetryableDbError(error.message)
    if (!data || data.org_id !== orgId) return unlinked
  }
  if (match.company_id) {
    const { data, error } = await admin
      .from("companies")
      .select("org_id")
      .eq("id", match.company_id)
      .maybeSingle()
    if (error) throw new RetryableDbError(error.message)
    if (!data || data.org_id !== orgId) return unlinked
  }
  if (match.profile_id) {
    // A profile belongs to an org through organization_members — a standalone
    // profile match (client/trade) can otherwise carry a same-address person
    // from another tenant. Drop attribution unless they're a member here. A
    // LOOKUP error is NOT a miss — throw so the webhook retries.
    const { data, error } = await admin
      .from("organization_members")
      .select("profile_id")
      .eq("org_id", orgId)
      .eq("profile_id", match.profile_id)
      .maybeSingle()
    if (error) throw new RetryableDbError(error.message)
    if (!data) return unlinked
  }
  return match
}

/** `"Jane Doe" <jane@x.com>` → `jane@x.com`; bare addresses pass through. */
function parseAddress(input: string): string {
  const m = /<([^>]+)>/.exec(input)
  return (m ? m[1] : input).trim()
}

/** `"Jane Doe" <jane@x.com>` → `Jane Doe`; bare addresses pass through. */
function displayName(input: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(input)
  return (m ? m[1] : parseAddress(input)).trim()
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000)
}

async function projectName(
  admin: AdminClient,
  projectId: string
): Promise<string | null> {
  const { data } = await admin
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle()
  return data?.name ?? null
}
