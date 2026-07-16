import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { purgeProjectTrash } from "@/lib/trash-purge"
import { TRASH_RETENTION_DAYS } from "@/lib/trash"

/**
 * Daily "Recently deleted" retention sweep. Fired by Vercel Cron
 * (vercel.json). The History page also purges lazily on load, but that only
 * covers projects staff actually revisit — this sweep enforces the 30-day
 * expiry (snapshots, bid tokens, attachment Storage objects) everywhere.
 *
 * Per-project failures are isolated and reported; the failed project's rows
 * survive untouched and retry tomorrow (Storage objects are removed BEFORE
 * rows are finalized — see lib/trash-purge.ts).
 *
 * Auth mirrors the other crons: Authorization: Bearer ${CRON_SECRET}.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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

  const cutoff = new Date(
    Date.now() - TRASH_RETENTION_DAYS * 86_400_000
  ).toISOString()
  const { data: rows, error } = await supabase
    .from("deleted_items")
    .select("project_id")
    .lt("deleted_at", cutoff)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const projectIds = [...new Set((rows ?? []).map((r) => r.project_id))]
  let purged = 0
  let removedObjects = 0
  const failures: { project_id: string; error: string }[] = []
  for (const projectId of projectIds) {
    try {
      const result = await purgeProjectTrash(supabase, projectId)
      purged += result.purged
      removedObjects += result.removedObjects
    } catch (e) {
      failures.push({
        project_id: projectId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok: failures.length === 0,
    projects: projectIds.length,
    purged,
    removedObjects,
    failures,
  })
}
