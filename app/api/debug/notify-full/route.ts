import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { sendEmail } from "@/lib/email"

// TEMPORARY diagnostic. Runs the *fixed* notifyStaffOfApprovedDecision query
// end-to-end against the latest approved decision and actually calls sendEmail,
// returning the result of every stage so we can see exactly where the approval
// email stops. Remove once approval emails are confirmed working.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const admin = createSupabaseAdminClient()
  if (!admin) return NextResponse.json({ stage: "admin", ok: false })

  const { data: latest } = await admin
    .from("decisions")
    .select("id, number, title")
    .eq("status", "approved")
    .order("approved_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!latest) return NextResponse.json({ stage: "latest", ok: false })

  const { data: decision, error: decisionErr } = await admin
    .from("decisions")
    .select(
      `id, number, kind, title, description, cost_delta, markup_percent,
       status, due_date, approved_at, selected_choice_id,
       project_id, created_by, approved_by_client_id,
       projects:project_id (id, name, project_number, address),
       creator:created_by (full_name, email),
       client_approver:approved_by_client_id (full_name, email),
       decision_choices!decision_choices_decision_id_fkey (id, title, description, price_delta, position),
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
  const emails = (staff ?? [])
    .map((p) => p.email)
    .filter((e): e is string => !!e)

  let sendResult: unknown = "not attempted"
  if (decision && emails.length) {
    sendResult = await sendEmail({
      to: emails,
      subject: `[probe] approval email path test — ${latest.title}`,
      text: "This confirms the approval-email query + sendEmail path works.",
    })
  }

  return NextResponse.json({
    decisionId: latest.id,
    decisionQuery: {
      found: !!decision,
      error: decisionErr?.message ?? null,
      errorCode: (decisionErr as { code?: string } | null)?.code ?? null,
    },
    staffQuery: { count: emails.length, error: staffErr?.message ?? null },
    sendResult,
  })
}
