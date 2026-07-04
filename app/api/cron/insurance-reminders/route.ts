import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { sendEmail, appUrl } from "@/lib/email"
import { buildInsuranceRequestEmail } from "@/lib/insurance/reminder-email"

/**
 * Daily insurance-expiration reminders. Fired by Vercel Cron (vercel.json).
 *
 * For every CURRENT policy (the latest expiration on file for its
 * company+type) expiring within the next 7 days that hasn't been reminded:
 * send the company ONE email listing everything about to lapse, with their
 * tokenized upload link, then stamp reminder_sent_at on those policies so
 * tomorrow's run doesn't repeat itself.
 *
 * Skips companies with no email on file (their policies stay unstamped, so
 * they'll go out automatically if an email is added within the window) and
 * companies with notifications_enabled = false (the "keep imported subs
 * quiet during testing" switch — same behavior as assignment notifications).
 *
 * Auth mirrors the email-digest cron: Authorization: Bearer ${CRON_SECRET}.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WINDOW_DAYS = 7

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    )
  }
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 401 })
  }

  const supabase = createSupabaseAdminClient()
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 }
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  const windowEnd = new Date(Date.now() + WINDOW_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10)

  // Candidates: unreminded policies expiring inside the window.
  const { data: candidates, error: candErr } = await supabase
    .from("insurance_policies")
    .select("id, company_id, type, expiration_date")
    .is("reminder_sent_at", null)
    .gte("expiration_date", today)
    .lte("expiration_date", windowEnd)
  if (candErr) {
    return NextResponse.json({ ok: false, error: candErr.message }, { status: 500 })
  }
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, reminded: [] })
  }

  // A policy is only worth reminding about if it's the company's CURRENT
  // one for that type — if a renewal with a later expiration is already on
  // file, the expiring row is history, not a problem.
  const companyIds = Array.from(new Set(candidates.map((c) => c.company_id)))
  const { data: allPolicies, error: allErr } = await supabase
    .from("insurance_policies")
    .select("company_id, type, expiration_date")
    .in("company_id", companyIds)
  if (allErr) {
    return NextResponse.json({ ok: false, error: allErr.message }, { status: 500 })
  }
  const latestByCompanyType = new Map<string, string>()
  for (const p of allPolicies ?? []) {
    const key = `${p.company_id}:${p.type}`
    const prev = latestByCompanyType.get(key)
    if (!prev || p.expiration_date > prev) {
      latestByCompanyType.set(key, p.expiration_date)
    }
  }
  const current = candidates.filter(
    (c) => latestByCompanyType.get(`${c.company_id}:${c.type}`) === c.expiration_date
  )
  if (current.length === 0) {
    return NextResponse.json({ ok: true, reminded: [] })
  }

  const { data: companies, error: compErr } = await supabase
    .from("companies")
    .select("id, name, email, contact_name, notifications_enabled, insurance_upload_token")
    .in("id", Array.from(new Set(current.map((c) => c.company_id))))
  if (compErr) {
    return NextResponse.json({ ok: false, error: compErr.message }, { status: 500 })
  }
  const companyById = new Map((companies ?? []).map((c) => [c.id, c]))

  const summary: {
    company: string
    policies: number
    sent: boolean
    reason?: string
  }[] = []

  const byCompany = new Map<string, typeof current>()
  for (const c of current) {
    const list = byCompany.get(c.company_id) ?? []
    list.push(c)
    byCompany.set(c.company_id, list)
  }

  for (const [companyId, policies] of byCompany) {
    const company = companyById.get(companyId)
    if (!company) continue
    if (!company.notifications_enabled) {
      summary.push({
        company: company.name,
        policies: policies.length,
        sent: false,
        reason: "notifications disabled for this company",
      })
      continue
    }
    if (!company.email) {
      summary.push({
        company: company.name,
        policies: policies.length,
        sent: false,
        reason: "no email on file",
      })
      continue
    }

    // CLAIM before sending: atomically stamp only rows still unstamped and
    // read back what we actually got. Two overlapping invocations can't both
    // claim the same policy, so nobody gets the same reminder twice.
    const { data: claimed, error: claimErr } = await supabase
      .from("insurance_policies")
      .update({ reminder_sent_at: new Date().toISOString() })
      .in(
        "id",
        policies.map((p) => p.id)
      )
      .is("reminder_sent_at", null)
      .select("id, type, expiration_date")
    if (claimErr) {
      summary.push({
        company: company.name,
        policies: policies.length,
        sent: false,
        reason: `claim failed: ${claimErr.message}`,
      })
      continue
    }
    if (!claimed || claimed.length === 0) {
      // Another run already claimed these — nothing to do.
      continue
    }

    const uploadUrl = appUrl(`/insurance-upload/${company.insurance_upload_token}`)
    const message = buildInsuranceRequestEmail({
      companyName: company.name,
      contactName: company.contact_name,
      expiring: claimed.map((p) => ({
        type: p.type,
        expiration_date: p.expiration_date,
      })),
      uploadUrl,
    })
    const result = await sendEmail({
      to: company.email,
      subject: message.subject,
      text: message.text,
    })

    if (result.sent) {
      summary.push({
        company: company.name,
        policies: claimed.length,
        sent: true,
      })
    } else {
      // Release the claim so tomorrow's run retries this company.
      const { error: unclaimErr } = await supabase
        .from("insurance_policies")
        .update({ reminder_sent_at: null })
        .in(
          "id",
          claimed.map((p) => p.id)
        )
      summary.push({
        company: company.name,
        policies: claimed.length,
        sent: false,
        reason: `${result.reason}${
          unclaimErr ? ` (and unclaim failed: ${unclaimErr.message})` : ""
        }`,
      })
    }
  }

  return NextResponse.json({ ok: true, reminded: summary })
}
