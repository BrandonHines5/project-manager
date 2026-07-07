"use client"

import { useState, useMemo, useTransition } from "react"
import { toast } from "sonner"
import {
  Plus,
  NotebookPen,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Users,
  Clock,
  Sparkles,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { formatDate } from "@/lib/utils"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"
import { DailyLogDrawer } from "@/components/daily-logs/daily-log-drawer"
import { LogCommentsToggle } from "@/components/daily-logs/log-comments-toggle"
import { draftClientUpdate } from "@/app/actions/daily-logs"

type DrawerInitial = {
  notes?: string
  visibility?: Enums<"daily_log_visibility">
}

export type DailyLogsData = {
  project_id: string
  role: UserRole
  me_name: string
  cost_plus: boolean
  logs: Tables<"daily_logs">[]
  subs_on_site: Tables<"daily_log_subs_on_site">[]
  attachments: Tables<"daily_log_attachments">[]
  profiles: Pick<Tables<"profiles">, "id" | "full_name" | "email">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  signed_urls: Record<string, string>
  comments: Tables<"daily_log_comments">[]
  open_log_id: string | null
}

export function DailyLogsClient({ data }: { data: DailyLogsData }) {
  const canEdit = data.role === "staff"
  const [drawerState, setDrawerState] = useState<
    | { mode: "create"; initial?: DrawerInitial }
    | { mode: "edit"; logId: string }
    | null
  >(
    // Deep link from the Communications feed / bell: staff land in the
    // drawer; clients get the card's comment thread auto-expanded instead
    // (they never see the editor drawer).
    data.open_log_id && canEdit
      ? { mode: "edit", logId: data.open_log_id }
      : null
  )
  const [drafting, startDrafting] = useTransition()

  // AI-draft a homeowner update from the last week of internal logs, then
  // open the create drawer prefilled with it (preset to client-visible).
  // Nothing is saved until the staffer reviews and saves in the drawer.
  function draftClientUpdateNow() {
    const to = new Date()
    const from = new Date(to)
    from.setDate(from.getDate() - 6)
    const iso = (d: Date) => d.toLocaleDateString("en-CA")
    startDrafting(async () => {
      const res = await draftClientUpdate({
        project_id: data.project_id,
        from_date: iso(from),
        to_date: iso(to),
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setDrawerState({
        mode: "create",
        initial: { notes: res.draft, visibility: "client" },
      })
    })
  }

  const editingLog =
    drawerState?.mode === "edit"
      ? data.logs.find((l) => l.id === drawerState.logId)
      : null

  const stats = useMemo(() => {
    const total = data.logs.length
    const clientVisible = data.logs.filter((l) => l.visibility === "client").length
    return { total, clientVisible, internal: total - clientVisible }
  }, [data.logs])

  // Per-job labor hours, rolled up by the person who authored each log.
  // Only meaningful on cost-plus jobs.
  const labor = useMemo(() => {
    if (!data.cost_plus) return null
    const byPerson = new Map<string, number>()
    let total = 0
    for (const l of data.logs) {
      const h = l.hours_worked ?? 0
      if (h <= 0) continue
      total += h
      byPerson.set(l.created_by, (byPerson.get(l.created_by) ?? 0) + h)
    }
    const rows = Array.from(byPerson.entries())
      .map(([profileId, hours]) => {
        const p = data.profiles.find((x) => x.id === profileId)
        return { name: p?.full_name || p?.email || "Unknown", hours }
      })
      .sort((a, b) => b.hours - a.hours)
    return { total, rows }
  }, [data.cost_plus, data.logs, data.profiles])

  const fmtHours = (h: number) =>
    Number.isInteger(h) ? String(h) : h.toFixed(2).replace(/\.?0+$/, "")

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-6 text-sm">
          <Stat label="Logs" value={stats.total} />
          <Stat label="Internal" value={stats.internal} />
          <Stat label="Client-visible" value={stats.clientVisible} />
          {labor && <Stat label="Labor hours" value={fmtHours(labor.total)} />}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={draftClientUpdateNow}
              disabled={drafting}
              title="Draft a client-visible update from the last week's internal logs"
            >
              {drafting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Draft client update
            </Button>
            <Button
              onClick={() => setDrawerState({ mode: "create" })}
              // Disabled while a draft resolves: opening a blank create
              // drawer mid-draft would race the draft's own drawer open and
              // silently drop the AI text.
              disabled={drafting}
            >
              <Plus className="h-4 w-4" /> New job log
            </Button>
          </div>
        )}
      </div>

      {labor && labor.total > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4 text-brand-600" />
            Labor hours summary
            <span className="ml-auto tabular-nums">
              {fmtHours(labor.total)} hrs total
            </span>
          </div>
          <ul className="mt-3 divide-y divide-border text-sm">
            {labor.rows.map((r) => (
              <li
                key={r.name}
                className="flex items-center justify-between py-1.5"
              >
                <span>{r.name}</span>
                <span className="tabular-nums font-medium">
                  {fmtHours(r.hours)} hrs
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.logs.length === 0 ? (
        <EmptyState
          icon={<NotebookPen className="h-10 w-10" />}
          title="No job logs yet"
          description={
            canEdit
              ? "Job logs capture what happened on site each day, with photos and which subs were there. Mark each one as internal-only or client-visible."
              : "No logs are visible to you yet."
          }
          action={
            canEdit ? (
              <Button onClick={() => setDrawerState({ mode: "create" })}>
                <Plus className="h-4 w-4" /> New job log
              </Button>
            ) : null
          }
        />
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {data.logs.map((log) => (
            <DailyLogCard
              key={log.id}
              log={log}
              data={data}
              onClick={() =>
                canEdit
                  ? setDrawerState({ mode: "edit", logId: log.id })
                  : null
              }
              clickable={canEdit}
            />
          ))}
        </ul>
      )}

      {drawerState && canEdit && (
        <DailyLogDrawer
          // The drawer seeds its notes/visibility state on mount, so any
          // change of what we're editing must remount it — otherwise a
          // drawerState swap (e.g. an AI draft resolving after "New job log"
          // was already open) updates props the drawer never re-reads.
          key={
            drawerState.mode === "edit"
              ? `edit-${drawerState.logId}`
              : drawerState.initial
                ? "create-draft"
                : "create-blank"
          }
          open={true}
          onClose={() => setDrawerState(null)}
          data={data}
          mode={drawerState.mode}
          log={editingLog ?? undefined}
          initial={
            drawerState.mode === "create" ? drawerState.initial : undefined
          }
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  )
}

function DailyLogCard({
  log,
  data,
  onClick,
  clickable,
}: {
  log: Tables<"daily_logs">
  data: DailyLogsData
  onClick: () => void
  clickable: boolean
}) {
  const subs = data.subs_on_site.filter((s) => s.daily_log_id === log.id)
  const atts = data.attachments.filter((a) => a.daily_log_id === log.id)
  const comments = data.comments.filter((c) => c.daily_log_id === log.id)
  const isClient = log.visibility === "client"

  return (
    <li
      onClick={onClick}
      className={`bg-surface border rounded-lg p-4 transition-colors ${
        clickable
          ? "cursor-pointer hover:border-brand-500"
          : ""
      } ${
        isClient
          ? "border-l-4 border-l-brand-500 border-border"
          : "border-l-4 border-l-zinc-400 border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {formatDate(log.log_date)}
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            {isClient ? (
              <Badge tone="brand">
                <Eye className="h-3 w-3" /> Client visible
              </Badge>
            ) : (
              <Badge tone="muted">
                <EyeOff className="h-3 w-3" /> Internal only
              </Badge>
            )}
            {data.cost_plus && log.hours_worked != null && log.hours_worked > 0 && (
              <Badge tone="info">
                <Clock className="h-3 w-3" /> {log.hours_worked} hrs
              </Badge>
            )}
          </div>
        </div>
        <div className="text-xs text-muted">{formatDate(log.created_at)}</div>
      </div>

      {log.notes && (
        <p className="mt-3 text-sm text-foreground line-clamp-4 whitespace-pre-wrap">
          {log.notes}
        </p>
      )}

      {atts.length > 0 && (
        <div className="mt-3 flex gap-1.5">
          {atts.slice(0, 5).map((a) => {
            const url = data.signed_urls[a.storage_path]
            const isImage = a.file_type?.startsWith("image/")
            if (isImage && url) {
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={a.id}
                  src={url}
                  alt={a.caption ?? a.file_name}
                  className="h-14 w-14 rounded object-cover border border-border"
                />
              )
            }
            return (
              <div
                key={a.id}
                className="h-14 w-14 rounded border border-border bg-background flex items-center justify-center text-xs text-muted"
                title={a.file_name}
              >
                <ImageIcon className="h-4 w-4" />
              </div>
            )
          })}
          {atts.length > 5 && (
            <div className="h-14 w-14 rounded border border-border bg-background flex items-center justify-center text-xs text-muted">
              +{atts.length - 5}
            </div>
          )}
        </div>
      )}

      {subs.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted flex-wrap">
          <Users className="h-3.5 w-3.5" />
          <span>On site:</span>
          {subs.map((s) => {
            const c = data.companies.find((x) => x.id === s.company_id)
            return (
              <span
                key={s.company_id}
                className="inline-flex items-center rounded-full bg-background px-2 py-0.5 border border-border"
              >
                {c?.name ?? "?"}
              </span>
            )
          })}
        </div>
      )}

      {/* Comments — the client's surface for this log (staff can also use
          the drawer thread). stopPropagation so interacting with the thread
          doesn't open the staff editor. Auto-expand when a notification
          deep-links a client to this log. */}
      <div onClick={(e) => e.stopPropagation()}>
        <LogCommentsToggle
          dailyLogId={log.id}
          projectId={data.project_id}
          comments={comments.map((c) => ({
            id: c.id,
            author_name: c.author_name,
            author_role: null,
            body: c.body,
            created_at: c.created_at,
          }))}
          meName={data.me_name}
          canPost={data.role === "staff" || log.visibility === "client"}
          placeholder={
            data.role === "client"
              ? "Question or note for the builder…"
              : "Reply to client / leave a note"
          }
          initialOpen={data.open_log_id === log.id && data.role !== "staff"}
        />
      </div>
    </li>
  )
}
