import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { buildFeed, type FeedProfile } from "@/lib/comms/feed"
import type { ComposeContact } from "@/components/comms/compose-dialog"
import { GlobalCommunicationsClient } from "./communications-client"

export const metadata = { title: "Communications — Hines Homes" }

const LIMIT = 300

/**
 * Global staff hub: every call, text and email across the business in one
 * searchable place. Phone traffic captured directly through Quo (typed in the
 * Quo app or received) lands here automatically — auto-filed to a job only
 * when the number maps to a single active job, otherwise left global. Staff
 * never have to place these; an optional per-message "file to job" is offered
 * for the occasional one worth attaching. Comments live on their project tabs;
 * this page is about phone/email traffic. Dismissed rows are hidden.
 */
export default async function GlobalCommunicationsPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [{ data: recent }, { data: projects }, { data: profiles }, { data: companies }] =
    await Promise.all([
      supabase
        .from("communications")
        .select("*")
        .neq("status", "ignored")
        .order("occurred_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("projects")
        .select("id, name, project_number")
        .order("project_number", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, role"),
      supabase
        .from("companies")
        .select("id, name, email, phone, phone_secondary, type, trade_category")
        .order("name"),
    ])

  const feed = buildFeed({
    decisionComments: [],
    bidComments: [],
    poComments: [],
    scheduleComments: [],
    dailyLogComments: [],
    communications: recent ?? [],
    profiles: (profiles ?? []) as FeedProfile[],
  })

  const projectNames = new Map((projects ?? []).map((p) => [p.id, p.name]))

  // Compose targets: the whole company directory. Address display is
  // informational — composeMessage re-resolves it server-side.
  const contacts: ComposeContact[] = (companies ?? []).map((c) => ({
    id: `company:${c.id}`,
    name: c.name,
    detail: c.type === "client" ? "client" : c.trade_category || c.type,
    email: c.email,
    phone: c.phone || c.phone_secondary,
    recipient: { kind: "company", company_id: c.id },
  }))

  return (
    <GlobalCommunicationsClient
      feed={feed.map((f) => ({
        ...f,
        projectName: f.projectId ? (projectNames.get(f.projectId) ?? null) : null,
      }))}
      projects={projects ?? []}
      contacts={contacts}
    />
  )
}
