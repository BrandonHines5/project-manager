import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import {
  buildFeed,
  type FeedItem,
  type FeedProfile,
} from "@/lib/comms/feed"
import { GlobalCommunicationsClient } from "./communications-client"

export const metadata = { title: "Communications — Hines Homes" }

const LIMIT = 300

/**
 * Global staff hub: the needs-review queue (traffic the matcher couldn't
 * attribute to a project) plus a recent cross-project channel feed. Comments
 * live on their project tabs; this page is about phone/email traffic.
 */
export default async function GlobalCommunicationsPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [{ data: needsReview }, { data: recent }, { data: projects }, { data: profiles }] =
    await Promise.all([
      supabase
        .from("communications")
        .select("*")
        .eq("status", "needs_review")
        .order("occurred_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("communications")
        .select("*")
        .eq("status", "logged")
        .order("occurred_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("projects")
        .select("id, name, project_number")
        .order("project_number", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, role"),
    ])

  const emptyComments = {
    decisionComments: [],
    bidComments: [],
    poComments: [],
    scheduleComments: [],
    dailyLogComments: [],
  }
  const feed = buildFeed({
    ...emptyComments,
    communications: recent ?? [],
    profiles: (profiles ?? []) as FeedProfile[],
  })
  const reviewFeed: FeedItem[] = buildFeed({
    ...emptyComments,
    communications: needsReview ?? [],
    profiles: (profiles ?? []) as FeedProfile[],
  })
  // Carry the raw communication id + partial attribution for the queue UI.
  const review = (needsReview ?? []).map((m) => ({
    communication_id: m.id,
    company_id: m.company_id,
    item: reviewFeed.find((f) => f.id === `comm:${m.id}`)!,
  }))

  const projectNames = new Map((projects ?? []).map((p) => [p.id, p.name]))

  return (
    <GlobalCommunicationsClient
      review={review}
      feed={feed.map((f) => ({
        ...f,
        projectName: f.projectId ? (projectNames.get(f.projectId) ?? null) : null,
      }))}
      projects={projects ?? []}
    />
  )
}
