import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireSession } from "@/lib/auth"
import {
  buildFeed,
  type BidCommentRow,
  type DailyLogCommentRow,
  type DecisionCommentRow,
  type FeedProfile,
  type PoCommentRow,
  type ScheduleCommentRow,
} from "@/lib/comms/feed"
import { CommunicationsClient } from "./communications-client"

export const metadata = { title: "Communications — Hines Homes" }

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
    .select("id, name")
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

  return (
    <CommunicationsClient
      feed={feed}
      projectId={projectId}
      role={profile.role}
    />
  )
}
