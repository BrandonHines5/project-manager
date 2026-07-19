import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * Daily sandbox hard-delete sweep (Stage S / S4). Fired by Vercel Cron
 * (vercel.json). Permanently deletes trial orgs whose sandbox_expires_at is more
 * than GRACE_DAYS in the past — i.e. a 30-day grace measured from the END of the
 * 7-day trial (sandbox_expires_at is already 7 days past signup, so this does NOT
 * re-add the trial). For each org: delete_organization() tears down all
 * org-scoped data in FK order (it refuses anything that isn't a sandbox trial,
 * so a subscriber can never be wiped), then the members' auth users are deleted
 * if they no longer belong to any org.
 *
 * IRREVERSIBLE, so gated hard:
 *  - Authorization: Bearer ${CRON_SECRET} (like the other crons).
 *  - Kill switch SANDBOX_CLEANUP_ENABLED must be exactly "true" — OFF by default,
 *    so nothing is ever deleted until it's deliberately enabled after S1–S3 are
 *    proven in production.
 *
 * Known gap (documented, low-risk): Storage objects (brand-assets/{org_id}/…,
 * project-files) are not swept here — they're private/orphaned with no access
 * once the org is gone, just storage cost. A future sweep can reclaim them.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Grace AFTER the trial's end (sandbox_expires_at) before the hard delete.
const GRACE_DAYS = 30
// Bounded per run; the daily cadence drains any backlog.
const MAX_PER_RUN = 200

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

  // Kill switch — OFF by default. An irreversible tenant wipe never runs until
  // SANDBOX_CLEANUP_ENABLED is explicitly set to "true" in the environment.
  if (process.env.SANDBOX_CLEANUP_ENABLED !== "true") {
    return NextResponse.json({ ok: true, disabled: true, deleted: [] })
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 }
    )
  }

  const cutoff = new Date(Date.now() - GRACE_DAYS * 86_400_000).toISOString()

  // Sandbox orgs whose trial ended more than GRACE_DAYS ago. Status is almost
  // always 'sandbox_expired' by now (the layout's lazy flip), but include
  // 'sandbox_active' defensively — delete_organization re-checks status anyway.
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, name, status, sandbox_expires_at")
    .in("status", ["sandbox_expired", "sandbox_active"])
    .not("sandbox_expires_at", "is", null)
    .lt("sandbox_expires_at", cutoff)
    .order("sandbox_expires_at", { ascending: true })
    .limit(MAX_PER_RUN)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const deleted: { orgId: string; members: number; authDeleted: number }[] = []
  const failures: { orgId: string; error: string }[] = []

  for (const org of orgs ?? []) {
    try {
      const { data: members, error: delErr } = await admin.rpc(
        "delete_organization",
        { p_org: org.id }
      )
      if (delErr) throw new Error(delErr.message)
      const memberIds = (members ?? [])
        .map((m) => m.deleted_member)
        .filter((id): id is string => !!id)

      // Delete the auth user for any member no longer in ANY org (their org
      // membership was just cascaded away). A user still in another org is left
      // alone. Deleting the auth user cascades its profile row.
      let authDeleted = 0
      for (const pid of memberIds) {
        const { count } = await admin
          .from("organization_members")
          .select("*", { count: "exact", head: true })
          .eq("profile_id", pid)
        if ((count ?? 0) === 0) {
          const { error: authErr } = await admin.auth.admin.deleteUser(pid)
          if (authErr) {
            console.error(
              `[sandbox-cleanup] deleteUser ${pid} failed: ${authErr.message}`
            )
          } else {
            authDeleted++
          }
        }
      }

      console.log(
        `[sandbox-cleanup] deleted org ${org.id} (${org.name}) — ${memberIds.length} members, ${authDeleted} auth users`
      )
      deleted.push({ orgId: org.id, members: memberIds.length, authDeleted })
    } catch (e) {
      // Isolate per-org failures — one bad org must not abort the sweep; it
      // survives and retries tomorrow.
      console.error(
        `[sandbox-cleanup] org ${org.id} failed: ${(e as Error).message}`
      )
      failures.push({ orgId: org.id, error: (e as Error).message })
    }
  }

  return NextResponse.json({
    ok: true,
    deletedCount: deleted.length,
    deleted,
    failures,
  })
}
