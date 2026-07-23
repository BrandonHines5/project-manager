import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

type AdminClient = SupabaseClient<Database>

export type MatchResult = {
  project_id: string | null
  company_id: string | null
  profile_id: string | null
  counterparty_name: string | null
  status: "logged" | "needs_review"
}

const NO_MATCH: MatchResult = {
  project_id: null,
  company_id: null,
  profile_id: null,
  counterparty_name: null,
  status: "needs_review",
}

// How far back "recent conversation" evidence reaches. Kept short on
// purpose: a sub's active thread is days old, and a stale project stamp
// misfiling this week's replies is worse than leaving them global.
const COMM_RECENCY_WINDOW_DAYS = 7

/** Last 10 digits — same comparison as the DB's normalize_phone(). */
function last10(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : null
}

/**
 * Discards attribution that resolved into a different org than the one the
 * event verifiably belongs to (the org owning a Twilio number, or the org
 * whose OpenPhone signing secret verified the event). Verifies the matched
 * project and company are in-org, and that a matched profile is an
 * organization member there; if any link isn't, drops project/company/profile
 * (keeping the display name) so a cross-tenant contact can never file a
 * message onto another org's job. No-op when the match carried no links.
 *
 * `lookupFailed` distinguishes a query ERROR (the match comes back unlinked
 * AND flagged, so a transient failure can't silently unlink) from a genuine
 * cross-org drop. Callers choose their posture: the Twilio webhook throws for
 * a retryable 503, the Quo webhook keeps the message with attribution dropped
 * (its always-200 contract can't retry without losing the event).
 */
export async function scopeMatchToOrg(
  admin: AdminClient,
  match: MatchResult,
  orgId: string
): Promise<{ match: MatchResult; lookupFailed: boolean }> {
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
    if (error) {
      console.warn("[comms] org-scope project lookup failed:", error.message)
      return { match: unlinked, lookupFailed: true }
    }
    if (!data || data.org_id !== orgId) {
      return { match: unlinked, lookupFailed: false }
    }
  }
  if (match.company_id) {
    const { data, error } = await admin
      .from("companies")
      .select("org_id")
      .eq("id", match.company_id)
      .maybeSingle()
    if (error) {
      console.warn("[comms] org-scope company lookup failed:", error.message)
      return { match: unlinked, lookupFailed: true }
    }
    if (!data || data.org_id !== orgId) {
      return { match: unlinked, lookupFailed: false }
    }
  }
  if (match.profile_id) {
    // A profile belongs to an org through organization_members — a standalone
    // profile match can otherwise carry a same-number person from another
    // tenant. Drop attribution unless they're a member here.
    const { data, error } = await admin
      .from("organization_members")
      .select("profile_id")
      .eq("org_id", orgId)
      .eq("profile_id", match.profile_id)
      .maybeSingle()
    if (error) {
      console.warn("[comms] org-scope membership lookup failed:", error.message)
      return { match: unlinked, lookupFailed: true }
    }
    if (!data) return { match: unlinked, lookupFailed: false }
  }
  return { match, lookupFailed: false }
}

/**
 * Attribute an inbound phone number / email address to a project, company,
 * and/or person. Resolution order:
 *
 *  1. A project's client contact field → that project directly (plus the
 *     client's profile when one shares the address, so their RLS read works).
 *  2. A profile (client via project_members, trade via company engagements).
 *  3. A company → its single active project engagement, if unambiguous.
 *
 * Anything ambiguous keeps whatever partial attribution was found and comes
 * back `needs_review` so staff can assign it from the global hub.
 */
export async function matchCounterparty(
  admin: AdminClient,
  opts: { phone?: string | null; email?: string | null }
): Promise<MatchResult> {
  const { data: rows, error } = opts.phone
    ? await admin.rpc("match_contacts_by_phone", { p: opts.phone })
    : opts.email
      ? await admin.rpc("match_contacts_by_email", { p: opts.email })
      : { data: null, error: null }
  if (error) {
    console.warn("[comms] contact match failed:", error.message)
    return NO_MATCH
  }
  const candidates = rows ?? []
  if (!candidates.length) return NO_MATCH

  const projectClients = candidates.filter((c) => c.kind === "project_client")
  const profiles = candidates.filter((c) => c.kind === "profile")
  const companies = candidates.filter((c) => c.kind === "company")

  // 1. Project client-contact match.
  const clientProjectIds = [
    ...new Set(projectClients.map((c) => c.project_id).filter(Boolean)),
  ] as string[]
  if (clientProjectIds.length === 1) {
    return {
      project_id: clientProjectIds[0],
      company_id: null,
      profile_id: profiles[0]?.profile_id ?? null,
      counterparty_name: projectClients[0].display_name,
      status: "logged",
    }
  }
  if (clientProjectIds.length > 1) {
    // Same client on several jobs — staff picks which one this is about.
    return {
      ...NO_MATCH,
      profile_id: profiles[0]?.profile_id ?? null,
      counterparty_name: projectClients[0].display_name,
    }
  }

  // 2. Profile match (client or trade login).
  if (profiles.length === 1) {
    const p = profiles[0]
    if (p.company_id) {
      // Trade: attribute to their company. Recent conversation context wins
      // over the formal-engagement heuristic — "we texted them about job X
      // yesterday" beats "they're assigned to one job somewhere".
      const projectId =
        (await recentProjectForCompany(admin, p.company_id, opts.phone)) ??
        (await singleProjectForCompany(admin, p.company_id))
      return {
        project_id: projectId,
        company_id: p.company_id,
        profile_id: p.profile_id,
        counterparty_name: p.display_name,
        status: projectId ? "logged" : "needs_review",
      }
    }
    const projectId = await singleProjectForProfile(admin, p.profile_id!)
    return {
      project_id: projectId,
      company_id: null,
      profile_id: p.profile_id,
      counterparty_name: p.display_name,
      status: projectId ? "logged" : "needs_review",
    }
  }

  // 3. Company match.
  const companyIds = [...new Set(companies.map((c) => c.company_id))]
  if (companyIds.length === 1 && companyIds[0]) {
    const projectId =
      (await recentProjectForCompany(admin, companyIds[0], opts.phone)) ??
      (await singleProjectForCompany(admin, companyIds[0]))
    return {
      project_id: projectId,
      company_id: companyIds[0],
      profile_id: null,
      counterparty_name: companies[0].display_name,
      status: projectId ? "logged" : "needs_review",
    }
  }

  // Multiple distinct contacts share this address — human call.
  return { ...NO_MATCH, counterparty_name: candidates[0].display_name }
}

/**
 * Recent-conversation attribution: the project stamped on this company's
 * communications inside the recency window — but only when EVERY recent
 * project-stamped row agrees on ONE project (a sub actively texted about
 * two jobs stays global; guessing between them would misfile half the
 * thread). Phone traffic only: when a phone is given, rows are narrowed to
 * that number's thread (outbound rows carry the sub's number in to_address;
 * from_address on outbound can be a "PN…" Quo id, so it's only trusted on
 * inbound rows). Evidence must include at least one OUTBOUND or
 * staff-logged row — otherwise a single auto-filed inbound reply would
 * feed itself for the whole window (misfile → evidence → misfile).
 */
async function recentProjectForCompany(
  admin: AdminClient,
  companyId: string,
  phone: string | null | undefined
): Promise<string | null> {
  // The requirement is about TEXTS — email attribution keeps its existing
  // behavior (project-client match / plus-tag / single engagement).
  if (!phone) return null
  const wanted = last10(phone)
  if (!wanted) return null
  try {
    const cutoff = new Date(
      Date.now() - COMM_RECENCY_WINDOW_DAYS * 86_400_000
    ).toISOString()
    // The phone-number thread filter needs normalization (last10), so it
    // can't run in SQL — fetch the company's whole recency window instead.
    // 500 is far above any real 7-day volume; if it's ever hit, the window
    // may be truncated and the all-agree check below can't be trusted, so
    // bail to "no evidence" rather than conclude from a partial set.
    const RECENCY_FETCH_CAP = 500
    const { data, error } = await admin
      .from("communications")
      .select(
        "project_id, direction, to_address, from_address, sent_by, occurred_at"
      )
      .eq("company_id", companyId)
      .not("project_id", "is", null)
      .neq("status", "ignored")
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .limit(RECENCY_FETCH_CAP)
    if (error || !data?.length) return null
    if (data.length >= RECENCY_FETCH_CAP) return null

    const thread = data.filter((r) =>
      r.direction === "outbound"
        ? last10(r.to_address) === wanted
        : last10(r.from_address) === wanted
    )
    if (thread.length === 0) return null
    if (!thread.some((r) => r.direction === "outbound" || r.sent_by)) {
      return null
    }
    const projects = new Set(thread.map((r) => r.project_id as string))
    return projects.size === 1 ? [...projects][0] : null
  } catch (e) {
    console.warn("[comms] recency lookup failed:", e)
    return null
  }
}

/** The company's one active project engagement, or null if 0 / several. */
async function singleProjectForCompany(
  admin: AdminClient,
  companyId: string
): Promise<string | null> {
  const [sa, br, po] = await Promise.all([
    admin
      .from("schedule_assignments")
      .select("schedule_items!inner(project_id)")
      .eq("company_id", companyId),
    admin
      .from("bid_recipients")
      .select("bid_packages!inner(project_id)")
      .eq("company_id", companyId),
    admin
      .from("purchase_orders")
      .select("project_id")
      .eq("company_id", companyId)
      .neq("status", "void"),
  ])
  const ids = new Set<string>()
  for (const r of sa.data ?? []) {
    const pid = (r as unknown as { schedule_items: { project_id: string } })
      .schedule_items?.project_id
    if (pid) ids.add(pid)
  }
  for (const r of br.data ?? []) {
    const pid = (r as unknown as { bid_packages: { project_id: string } })
      .bid_packages?.project_id
    if (pid) ids.add(pid)
  }
  for (const r of po.data ?? []) if (r.project_id) ids.add(r.project_id)
  return ids.size === 1 ? [...ids][0] : null
}

/** The profile's one project membership, or null if 0 / several. */
async function singleProjectForProfile(
  admin: AdminClient,
  profileId: string
): Promise<string | null> {
  const { data } = await admin
    .from("project_members")
    .select("project_id")
    .eq("profile_id", profileId)
  const ids = new Set((data ?? []).map((m) => m.project_id))
  return ids.size === 1 ? [...ids][0] : null
}
