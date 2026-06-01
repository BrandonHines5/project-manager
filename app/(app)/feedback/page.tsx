import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { FeedbackTable } from "@/components/feedback/feedback-table"
import type { FeedbackRow } from "@/lib/feedback"

export const metadata = { title: "Feedback & Requests — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function FeedbackPage() {
  const profile = await requireSession()
  const isStaff = profile.role === "staff"
  const supabase = await createSupabaseServerClient()

  // RLS scopes this automatically: staff see every request, everyone else sees
  // only the rows they submitted.
  const { data: rows, error } = await supabase
    .from("feedback_requests")
    .select("*")
    .order("created_at", { ascending: false })
  if (error) console.error("[feedback] failed to load requests:", error.message)

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">
          Feedback &amp; Requests
        </h1>
        <p className="text-sm text-muted">
          {isStaff
            ? "Review and triage update requests from your team and clients."
            : "Submit requests and track their status here."}
        </p>
      </div>
      <FeedbackTable rows={(rows ?? []) as FeedbackRow[]} isStaff={isStaff} />
    </div>
  )
}
