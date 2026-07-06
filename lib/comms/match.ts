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
      // Trade: attribute to their company; project via company engagements.
      const projectId = await singleProjectForCompany(admin, p.company_id)
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
    const projectId = await singleProjectForCompany(admin, companyIds[0])
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
