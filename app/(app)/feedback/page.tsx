import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { isLegacyOrgMember, isLegacyOrgOwner } from "@/lib/org"
import { FeedbackTable } from "@/components/feedback/feedback-table"
import type { FeedbackListRow } from "@/lib/feedback"

export const metadata = { title: "Feedback & Requests — BuildFox" }
export const dynamic = "force-dynamic"

export default async function FeedbackPage() {
  const profile = await requireSession()
  const isStaff = profile.role === "staff"
  const supabase = await createSupabaseServerClient()

  // Triage rights mirror the 0124 RLS: Hines (legacy-org) staff triage Hines
  // rows, and the platform operator (legacy-org OWNER) reads + triages every
  // org's rows. Builder-org staff are submitters here — their requests route
  // to the platform, so they get the tracking view, not the triage controls.
  const [legacyMember, platformAdmin] = isStaff
    ? await Promise.all([
        isLegacyOrgMember(supabase, profile.id),
        isLegacyOrgOwner(supabase, profile.id),
      ])
    : [false, false]
  const canTriage = isStaff && legacyMember

  // RLS scopes this automatically: staff see their org's requests (the
  // platform operator sees every org's), everyone else sees only the rows
  // they submitted. The org-name embed feeds the operator's Organization
  // column.
  const { data: rows, error } = await supabase
    .from("feedback_requests")
    .select("*, organizations:org_id(name)")
    .order("created_at", { ascending: false })
  // Surface real failures via the error boundary rather than rendering a
  // misleading "no requests" empty state.
  if (error) throw new Error(`Failed to load feedback requests: ${error.message}`)

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">
          Feedback &amp; Requests
        </h1>
        <p className="text-sm text-muted">
          {platformAdmin
            ? "Review and triage update requests from your team, clients, and builder accounts."
            : canTriage
              ? "Review and triage update requests from your team and clients."
              : "Submit requests and track their status here — the app team follows up on each one."}
        </p>
      </div>
      <FeedbackTable
        rows={(rows ?? []) as FeedbackListRow[]}
        isStaff={isStaff}
        canTriage={canTriage}
        showOrg={platformAdmin}
      />
    </div>
  )
}
