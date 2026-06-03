"use client"

import { useState, useMemo } from "react"
import { Plus, NotebookPen, Eye, EyeOff, Image as ImageIcon, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { formatDate } from "@/lib/utils"
import type { Tables } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"
import { DailyLogDrawer } from "@/components/daily-logs/daily-log-drawer"

export type DailyLogsData = {
  project_id: string
  role: UserRole
  logs: Tables<"daily_logs">[]
  subs_on_site: Tables<"daily_log_subs_on_site">[]
  attachments: Tables<"daily_log_attachments">[]
  profiles: Pick<Tables<"profiles">, "id" | "full_name" | "email">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  signed_urls: Record<string, string>
}

export function DailyLogsClient({ data }: { data: DailyLogsData }) {
  const [drawerState, setDrawerState] = useState<
    | { mode: "create" }
    | { mode: "edit"; logId: string }
    | null
  >(null)

  const canEdit = data.role === "staff"

  const editingLog =
    drawerState?.mode === "edit"
      ? data.logs.find((l) => l.id === drawerState.logId)
      : null

  const stats = useMemo(() => {
    const total = data.logs.length
    const clientVisible = data.logs.filter((l) => l.visibility === "client").length
    return { total, clientVisible, internal: total - clientVisible }
  }, [data.logs])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-6 text-sm">
          <Stat label="Logs" value={stats.total} />
          <Stat label="Internal" value={stats.internal} />
          <Stat label="Client-visible" value={stats.clientVisible} />
        </div>
        {canEdit && (
          <Button onClick={() => setDrawerState({ mode: "create" })}>
            <Plus className="h-4 w-4" /> New job log
          </Button>
        )}
      </div>

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
          open={true}
          onClose={() => setDrawerState(null)}
          data={data}
          mode={drawerState.mode}
          log={editingLog ?? undefined}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
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
          <div className="mt-1">
            {isClient ? (
              <Badge tone="brand">
                <Eye className="h-3 w-3" /> Client visible
              </Badge>
            ) : (
              <Badge tone="muted">
                <EyeOff className="h-3 w-3" /> Internal only
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
    </li>
  )
}
