import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

// TEMPORARY diagnostic. Runs the exact admin query from
// notifyStaffOfApprovedDecision against the latest approved decision and
// returns whether it succeeded + the error text — because the real function
// discards the query error and returns silently, and Vercel doesn't surface
// console output here. Remove once the approval-email bug is fixed.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json({ stage: "admin", ok: false, reason: "no admin client" })
  }

  const { data: latest, error: latestErr } = await admin
    .from("decisions")
    .select("id, number, title, status, approved_at")
    .eq("status", "approved")
    .order("approved_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestErr || !latest) {
    return NextResponse.json({
      stage: "latest",
      latestError: latestErr?.message ?? null,
      latest,
    })
  }

  const { data: decision, error: decisionErr } = await admin
    .from("decisions")
    .select(
      `id, number, kind, title, description, cost_delta, markup_percent,
       status, due_date, approved_at, selected_choice_id,
       project_id, created_by, approved_by_client_id,
       projects:project_id (id, name, project_number, address),
       creator:created_by (full_name, email),
       client_approver:approved_by_client_id (full_name, email),
       decision_choices (id, title, description, price_delta, position),
       decision_cost_items (description, quantity, unit, unit_cost, position,
         cost_codes:cost_code_id (code, name)),
       decision_followup_templates (title, due_offset_days, notes, position,
         assignee:assignee_profile_id (full_name),
         company:assignee_company_id (name)),
       decision_attachments (file_name, caption)`
    )
    .eq("id", latest.id)
    .maybeSingle()

  const { data: staff, error: staffErr } = await admin
    .from("profiles")
    .select("email")
    .eq("role", "staff")
    .eq("notifications_enabled", true)

  return NextResponse.json({
    decisionId: latest.id,
    decisionNumber: latest.number,
    decisionTitle: latest.title,
    decisionQuery: {
      found: !!decision,
      error: decisionErr?.message ?? null,
      errorDetails: decisionErr
        ? {
            code: (decisionErr as { code?: string }).code ?? null,
            details: (decisionErr as { details?: string }).details ?? null,
            hint: (decisionErr as { hint?: string }).hint ?? null,
          }
        : null,
    },
    staffQuery: {
      count: (staff ?? []).length,
      error: staffErr?.message ?? null,
    },
  })
}
