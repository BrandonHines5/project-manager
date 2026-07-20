import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireSession } from "@/lib/auth"
import {
  buildFeed,
  type BidCommentRow,
  type DailyLogCommentRow,
  type DecisionCommentRow,
  type FeedItem,
  type FeedProfile,
  type PoCommentRow,
  type ScheduleCommentRow,
} from "@/lib/comms/feed"
import { createCrmClient } from "@/lib/supabase/crm"
import { LEGACY_ORG_ID } from "@/lib/org"
import type { ComposeContact } from "@/components/comms/compose-dialog"
import { buildCompanyContacts } from "@/lib/comms/contacts"
import { CommunicationsClient } from "./communications-client"

export const metadata = { title: "Communications — BuildFox" }

// Per-source cap. The merged feed is client-paginated; if a project ever
// outgrows this, add server pagination (?before=) rather than raising it.
const LIMIT = 200

export default async function CommunicationsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, org_id, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2, created_at"
    )
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  // All six sources run under the viewer's session — RLS is the filter that
  // makes this tab "everyone sees only their own conversations".
  const [dc, bc, pc, sc, dlc, comms] = await Promise.all([
    supabase
      .from("decision_comments")
      .select("*, decisions!inner(id, project_id, number, title)")
      .eq("decisions.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("bid_comments")
      .select(
        "*, bid_recipients!inner(id, company_id, bid_package_id, companies:company_id(name), bid_packages!inner(id, project_id, number, title))"
      )
      .eq("bid_recipients.bid_packages.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("po_comments")
      .select(
        "*, purchase_orders!inner(id, project_id, number, title, company_id, companies:company_id(name))"
      )
      .eq("purchase_orders.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("schedule_item_comments")
      .select("*, schedule_items!inner(id, project_id, title)")
      .eq("schedule_items.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("daily_log_comments")
      .select("*, daily_logs!inner(id, project_id, log_date)")
      .eq("daily_logs.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase
      .from("communications")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "logged")
      .order("occurred_at", { ascending: false })
      .limit(LIMIT),
  ])

  const decisionComments = (dc.data ?? []) as unknown as DecisionCommentRow[]
  const bidComments = (bc.data ?? []) as unknown as BidCommentRow[]
  const poComments = (pc.data ?? []) as unknown as PoCommentRow[]
  const scheduleComments = (sc.data ?? []) as unknown as ScheduleCommentRow[]
  const dailyLogComments = (dlc.data ?? []) as unknown as DailyLogCommentRow[]
  const communications = comms.data ?? []

  // Resolve author display names/roles with the admin client — clients and
  // trades can't read other users' profiles rows under RLS, but showing
  // "who wrote this" (name only) is intended here. Falls back to the
  // session client (staff sees everything anyway) when the admin key is
  // absent.
  const authorIds = new Set<string>()
  for (const c of decisionComments) if (c.author_id) authorIds.add(c.author_id)
  for (const c of bidComments) if (c.author_profile_id) authorIds.add(c.author_profile_id)
  for (const c of poComments) if (c.author_profile_id) authorIds.add(c.author_profile_id)
  for (const c of scheduleComments) if (c.author_id) authorIds.add(c.author_id)
  for (const c of dailyLogComments) if (c.author_id) authorIds.add(c.author_id)
  for (const m of communications) if (m.sent_by) authorIds.add(m.sent_by)

  let profiles: FeedProfile[] = []
  if (authorIds.size > 0) {
    const lookupClient = createSupabaseAdminClient() ?? supabase
    const { data } = await lookupClient
      .from("profiles")
      .select("id, full_name, email, role")
      .in("id", Array.from(authorIds))
    profiles = data ?? []
  }

  const feed = buildFeed({
    decisionComments,
    bidComments,
    poComments,
    scheduleComments,
    dailyLogComments,
    communications,
    profiles,
  })

  // Sales-stage email history from the CRM (staff only — it predates the
  // client's portal relationship). The CRM synced these from Outlook against
  // the sales deal; we surface the ones exchanged with this project's client
  // BEFORE the job existed. Anything after that is (or will be) captured by
  // this app's own pipeline, so the date cutoff prevents double rows once
  // the Outlook sync is live. The CRM is Hines Homes' external system, so this
  // history only applies to a legacy-org project.
  if (profile.role === "staff" && project.org_id === LEGACY_ORG_ID) {
    const crmItems = await fetchCrmEmailHistory(
      projectId,
      [project.client_email, project.client_email_2].filter(
        (e): e is string => Boolean(e)
      ),
      project.created_at
    )
    feed.push(...crmItems)
    feed.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
  }

  // Compose targets (staff only — clients/trades never see the compose
  // button): this job's client contact(s) first, then the company directory.
  const contacts: ComposeContact[] = []
  if (profile.role === "staff") {
    const clientSlots = [
      { slot: 1 as const, name: project.client_name, email: project.client_email, phone: project.client_phone },
      { slot: 2 as const, name: project.client_name_2, email: project.client_email_2, phone: project.client_phone_2 },
    ]
    for (const c of clientSlots) {
      if (!c.email && !c.phone) continue
      contacts.push({
        id: `client:${c.slot}`,
        name: c.name || "Client",
        detail: "client",
        email: c.email,
        phone: c.phone,
        recipient: { kind: "project_client", project_id: projectId, slot: c.slot },
      })
    }
    contacts.push(...(await buildCompanyContacts(supabase)))
  }

  return (
    <CommunicationsClient
      feed={feed}
      projectId={projectId}
      role={profile.role}
      contacts={contacts}
    />
  )
}

type CrmEmailRow = {
  id: string
  subject: string | null
  body: string | null
  sender: string | null
  recipients: string | null
  sent_at: string | null
}

async function fetchCrmEmailHistory(
  projectId: string,
  clientEmails: string[],
  before: string
): Promise<FeedItem[]> {
  if (!clientEmails.length) return []
  const crm = createCrmClient()
  if (!crm) return []
  try {
    const pattern = clientEmails
      .map((e) => `sender.ilike.%${e}%,recipients.ilike.%${e}%`)
      .join(",")
    const { data, error } = await crm
      .from("emails")
      .select("id, subject, body, sender, recipients, sent_at")
      .or(pattern)
      .lt("sent_at", before)
      .order("sent_at", { ascending: false })
      .limit(100)
    if (error) {
      console.warn("[comms] CRM email history failed:", error.message)
      return []
    }
    const lowered = clientEmails.map((e) => e.toLowerCase())
    return ((data ?? []) as CrmEmailRow[]).map((e) => {
      const inbound = lowered.some((c) =>
        (e.sender ?? "").toLowerCase().includes(c)
      )
      return {
        id: `crm_email:${e.id}`,
        kind: "email" as const,
        direction: inbound ? ("inbound" as const) : ("outbound" as const),
        author: {
          name: (inbound ? e.sender : e.sender) ?? "CRM history",
          role: inbound ? ("external" as const) : ("staff" as const),
        },
        subject: e.subject,
        body: stripHtml(e.body ?? ""),
        occurredAt: e.sent_at ?? before,
        href: "",
        projectId,
        reply: null,
      }
    })
  } catch (err) {
    console.warn(
      "[comms] CRM email history exception:",
      err instanceof Error ? err.message : err
    )
    return []
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
}
