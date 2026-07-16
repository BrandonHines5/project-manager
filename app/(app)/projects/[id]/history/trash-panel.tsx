"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArchiveRestore, CheckCircle2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty"
import { restoreDeletedItem } from "@/app/actions/trash"
import { TRASH_RETENTION_DAYS, trashDaysLeft } from "@/lib/trash"
import { cn } from "@/lib/utils"
import { metaFor } from "./entity-meta"

export type TrashItem = {
  id: string
  entity_type: string
  entity_label: string | null
  deleted_by_name: string | null
  deleted_at: string
}

type RestoreOutcome = {
  key: number
  label: string
  ok: boolean
  messages: string[]
}

function formatDeletedAt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function TrashPanel({
  projectId,
  items,
}: {
  projectId: string
  items: TrashItem[]
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<RestoreOutcome[]>([])

  function restore(item: TrashItem) {
    if (pendingId) return
    setPendingId(item.id)
    const label = item.entity_label || metaFor(item.entity_type).singular
    startTransition(async () => {
      try {
        const res = await restoreDeletedItem({
          id: item.id,
          project_id: projectId,
        })
        setOutcomes((prev) => [
          {
            key: Date.now(),
            label,
            ok: true,
            messages: res.restored && res.warnings.length === 0
              ? ["Restored."]
              : res.warnings,
          },
          ...prev.slice(0, 4),
        ])
        router.refresh()
      } catch (e) {
        setOutcomes((prev) => [
          {
            key: Date.now(),
            label,
            ok: false,
            messages: [e instanceof Error ? e.message : "Restore failed."],
          },
          ...prev.slice(0, 4),
        ])
      } finally {
        setPendingId(null)
      }
    })
  }

  return (
    <div className="space-y-3">
      {outcomes.length > 0 && (
        <ul className="space-y-1.5">
          {outcomes.map((o) => (
            <li
              key={o.key}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-2.5 text-sm",
                o.ok
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-red-200 bg-red-50 text-red-900"
              )}
            >
              {o.ok ? (
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <div className="min-w-0">
                <span className="font-semibold break-words">{o.label}</span>
                {o.messages.map((m, i) => (
                  <p key={i} className="break-words">
                    {m}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<ArchiveRestore className="h-10 w-10" />}
          title="Nothing recently deleted"
          description={`Deleted schedule items, decisions, daily logs, files, bids and POs land here for ${TRASH_RETENTION_DAYS} days and can be restored with everything they contained.`}
        />
      ) : (
        <>
          <p className="text-xs text-muted">
            Deleted items are kept for {TRASH_RETENTION_DAYS} days, then removed
            for good — attachments included. Restoring brings back the item with
            its details, attachments and assignments.
          </p>
          <ul className="space-y-2">
            {items.map((item) => {
              const meta = metaFor(item.entity_type)
              const Icon = meta.icon
              const daysLeft = trashDaysLeft(item.deleted_at)
              return (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
                >
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      meta.className
                    )}
                    title={meta.label}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold break-words">
                      {item.entity_label || "(untitled)"}
                    </p>
                    {/* Browser-local time (repo convention) — the server
                        render can differ, so let hydration patch it. */}
                    <p className="text-xs text-muted" suppressHydrationWarning>
                      {meta.singular} · deleted by{" "}
                      {item.deleted_by_name ?? "System"} ·{" "}
                      {formatDeletedAt(item.deleted_at)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "hidden sm:inline text-xs whitespace-nowrap",
                      daysLeft <= 5 ? "text-red-600" : "text-muted"
                    )}
                    suppressHydrationWarning
                  >
                    {daysLeft <= 0
                      ? "expires today"
                      : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => restore(item)}
                  >
                    <RotateCcw
                      className={cn(
                        "h-3.5 w-3.5 mr-1",
                        pendingId === item.id && "animate-spin"
                      )}
                    />
                    {pendingId === item.id ? "Restoring…" : "Restore"}
                  </Button>
                </li>
              )
            })}
          </ul>
          {items.length >= 1000 && (
            <p className="text-center text-xs text-muted">
              Showing the latest 1,000 entries.
            </p>
          )}
        </>
      )}
    </div>
  )
}
