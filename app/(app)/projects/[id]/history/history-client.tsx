"use client"

import { useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  DollarSign,
  File,
  FileSignature,
  FolderKanban,
  Gavel,
  Hammer,
  History,
  ListTodo,
  NotebookPen,
  Palette,
  Receipt,
  Search,
  UserCheck,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty"
import { Input, Select } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Tables } from "@/lib/db/types"

type HistoryRow = Tables<"project_history">

const PAGE = 50

type EntityMeta = {
  // Filter pill ("Work items"), row sentence ("work item"), batch sentence
  // ("work items") — kept separate so acronyms like "POs" read right.
  label: string
  singular: string
  plural: string
  icon: LucideIcon
  className: string
}

const ENTITY_META: Record<string, EntityMeta> = {
  work_item: { label: "Work items", singular: "work item", plural: "work items", icon: Hammer, className: "text-brand-600 bg-brand-50" },
  todo: { label: "To-dos", singular: "to-do", plural: "to-dos", icon: ListTodo, className: "text-emerald-700 bg-emerald-50" },
  change_order: { label: "Change orders", singular: "change order", plural: "change orders", icon: FileSignature, className: "text-amber-700 bg-amber-50" },
  selection: { label: "Selections", singular: "selection", plural: "selections", icon: Palette, className: "text-purple-700 bg-purple-50" },
  daily_log: { label: "Daily logs", singular: "daily log", plural: "daily logs", icon: NotebookPen, className: "text-sky-700 bg-sky-50" },
  file: { label: "Files", singular: "file", plural: "files", icon: File, className: "text-zinc-600 bg-zinc-100" },
  payment: { label: "Payments", singular: "payment", plural: "payments", icon: DollarSign, className: "text-green-700 bg-green-50" },
  bid_package: { label: "Bids", singular: "bid package", plural: "bid packages", icon: Gavel, className: "text-orange-700 bg-orange-50" },
  purchase_order: { label: "POs", singular: "PO", plural: "POs", icon: Receipt, className: "text-cyan-700 bg-cyan-50" },
  member: { label: "Members", singular: "member", plural: "members", icon: Users, className: "text-blue-700 bg-blue-50" },
  role_assignment: { label: "Roles", singular: "role assignment", plural: "role assignments", icon: UserCog, className: "text-indigo-700 bg-indigo-50" },
  assignment: { label: "Assignments", singular: "assignment", plural: "assignments", icon: UserCheck, className: "text-teal-700 bg-teal-50" },
  project: { label: "Project", singular: "project", plural: "project", icon: FolderKanban, className: "text-rose-700 bg-rose-50" },
}

function humanize(s: string) {
  return s.replace(/_/g, " ")
}

// Unknown entity types (the audit trigger may outpace this map) still render,
// just with a generic icon and a humanized name.
function metaFor(type: string): EntityMeta {
  return (
    ENTITY_META[type] ?? {
      label: humanize(type) || "Other",
      singular: humanize(type) || "item",
      plural: `${humanize(type) || "item"}s`,
      icon: History,
      className: "text-muted bg-background",
    }
  )
}

const ACTION_VERB: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

function isEmpty(v: unknown) {
  return v === null || v === undefined || v === ""
}

function formatValue(v: unknown): string {
  if (isEmpty(v)) return "—"
  if (typeof v === "boolean") return v ? "yes" : "no"
  const s =
    typeof v === "string"
      ? v
      : typeof v === "number"
        ? String(v)
        : (JSON.stringify(v) ?? String(v))
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

type FieldChange = { from: unknown; to: unknown }

// Field diffs off an update row's `changes` jsonb, alphabetical, minus fields
// where both sides are empty (nothing to show).
function changesOf(row: HistoryRow): [string, FieldChange][] {
  if (
    row.action !== "update" ||
    !row.changes ||
    typeof row.changes !== "object" ||
    Array.isArray(row.changes)
  ) {
    return []
  }
  return Object.entries(row.changes)
    .map(([field, c]): [string, FieldChange] => {
      const fc = (
        c && typeof c === "object" && !Array.isArray(c) ? c : {}
      ) as { from?: unknown; to?: unknown }
      return [field, { from: fc.from, to: fc.to }]
    })
    .filter(([, c]) => !(isEmpty(c.from) && isEmpty(c.to)))
    .sort(([a], [b]) => a.localeCompare(b))
}

export function HistoryClient({ rows }: { rows: HistoryRow[] }) {
  const [entityType, setEntityType] = useState("all")
  const [action, setAction] = useState("all")
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(PAGE)

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.entity_type] = (c[r.entity_type] ?? 0) + 1
    return c
  }, [rows])

  // Only offer pills for types that actually appear — 13 always-on pills
  // would just be noise. Known types keep the map's order; strays go last.
  const typePills = useMemo(() => {
    const known = Object.keys(ENTITY_META).filter((t) => typeCounts[t])
    const unknown = Object.keys(typeCounts)
      .filter((t) => !(t in ENTITY_META))
      .sort()
    return [...known, ...unknown]
  }, [typeCounts])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (entityType !== "all" && r.entity_type !== entityType) return false
      if (action !== "all" && r.action !== action) return false
      if (!q) return true
      return (
        (r.entity_label ?? "").toLowerCase().includes(q) ||
        (r.actor_name ?? "System").toLowerCase().includes(q)
      )
    })
  }, [rows, entityType, action, query])

  // Collapse consecutive rows from one transaction (same actor, entity type
  // and action) into a single batch — a bulk shift touching 14 work items
  // reads as one entry, not 14.
  const batches = useMemo(() => {
    const out: HistoryRow[][] = []
    let sig: string | null = null
    for (const r of filtered) {
      const s = `${r.txid}|${r.actor_id ?? ""}|${r.entity_type}|${r.action}`
      if (out.length > 0 && s === sig) out[out.length - 1].push(r)
      else {
        out.push([r])
        sig = s
      }
    }
    return out
  }, [filtered])

  const shown = batches.slice(0, limit)

  // Group by calendar day for scannability.
  const groups = useMemo(() => {
    const out: { day: string; entries: HistoryRow[][] }[] = []
    for (const batch of shown) {
      const day = new Date(batch[0].created_at).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
      const last = out[out.length - 1]
      if (last && last.day === day) last.entries.push(batch)
      else out.push({ day, entries: [batch] })
    }
    return out
  }, [shown])

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <div className="flex gap-1 flex-wrap">
          {["all", ...typePills].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setEntityType(t)
                setLimit(PAGE)
              }}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                entityType === t
                  ? "bg-brand-500 text-white border-brand-500"
                  : "bg-surface text-muted border-border hover:text-foreground"
              )}
            >
              {t === "all" ? "All" : metaFor(t).label}
              <span className="ml-1 tabular-nums">
                {t === "all" ? rows.length : typeCounts[t]}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 w-full sm:w-auto">
          <Select
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setLimit(PAGE)
            }}
            aria-label="Filter by action"
            className="w-auto"
          >
            <option value="all">All</option>
            <option value="create">Created</option>
            <option value="update">Updated</option>
            <option value="delete">Deleted</option>
          </Select>
          <div className="relative flex-1 sm:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(PAGE)
              }}
              placeholder="Search items, people…"
              className="pl-8"
            />
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<History className="h-10 w-10" />}
          title={rows.length === 0 ? "No history yet" : "Nothing matches"}
          description={
            rows.length === 0
              ? "Changes to this project will appear here."
              : "Try a different filter or search."
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-background/95 backdrop-blur-sm text-xs font-semibold text-muted uppercase tracking-wide">
                {g.day}
              </div>
              <ul className="mt-1.5 space-y-2">
                {g.entries.map((batch) =>
                  batch.length === 1 ? (
                    <HistoryEntry key={batch[0].id} row={batch[0]} />
                  ) : (
                    <BatchEntry key={batch[0].id} rows={batch} />
                  )
                )}
              </ul>
            </div>
          ))}
          {batches.length > limit && (
            <div className="text-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setLimit((l) => l + PAGE)}
              >
                Show more ({batches.length - limit} older)
              </Button>
            </div>
          )}
          {rows.length === 500 && (
            <p className="text-center text-xs text-muted">
              Showing the latest 500 events.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function EntityBubble({ type }: { type: string }) {
  const meta = metaFor(type)
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
        meta.className
      )}
      title={meta.label}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
}

function DiffToggle({
  open,
  onToggle,
  label,
}: {
  open: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline cursor-pointer"
    >
      {open ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
      {label}
    </button>
  )
}

function DiffTable({ changes }: { changes: [string, FieldChange][] }) {
  return (
    <div className="mt-1.5 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <tbody>
          {changes.map(([field, c]) => (
            <tr key={field} className="border-b border-border last:border-b-0">
              <td className="px-2.5 py-1.5 font-medium text-muted whitespace-nowrap align-top">
                {humanize(field)}
              </td>
              <td className="px-2.5 py-1.5 align-top text-muted break-words">
                {formatValue(c.from)}
              </td>
              <td className="py-1.5 align-top text-muted" aria-hidden="true">
                →
              </td>
              <td className="px-2.5 py-1.5 align-top text-foreground break-words">
                {formatValue(c.to)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A single audit event: "Actor updated work item Foundation" + field diff. */
function HistoryEntry({ row }: { row: HistoryRow }) {
  const [open, setOpen] = useState(false)
  const meta = metaFor(row.entity_type)
  const changes = changesOf(row)

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
      <EntityBubble type={row.entity_type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="text-sm min-w-0 break-words">
            <span className="font-medium">{row.actor_name ?? "System"}</span>{" "}
            {ACTION_VERB[row.action] ?? row.action} {meta.singular}
            {row.entity_label && (
              <>
                {" "}
                <span className="font-semibold">{row.entity_label}</span>
              </>
            )}
          </p>
          <span className="text-xs text-muted ml-auto whitespace-nowrap">
            {formatTime(row.created_at)}
          </span>
        </div>
        {changes.length > 0 && (
          <div className="mt-1">
            <DiffToggle
              open={open}
              onToggle={() => setOpen((o) => !o)}
              label={`${changes.length} field${changes.length === 1 ? "" : "s"} changed`}
            />
            {open && <DiffTable changes={changes} />}
          </div>
        )}
      </div>
    </li>
  )
}

/** One transaction's worth of same-shaped events: "Actor updated 14 work items". */
function BatchEntry({ rows }: { rows: HistoryRow[] }) {
  const [open, setOpen] = useState(false)
  const first = rows[0]
  const meta = metaFor(first.entity_type)

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
      <EntityBubble type={first.entity_type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="text-sm min-w-0 break-words">
            <span className="font-medium">{first.actor_name ?? "System"}</span>{" "}
            {ACTION_VERB[first.action] ?? first.action}{" "}
            <span className="font-semibold">{rows.length}</span> {meta.plural}
          </p>
          <span className="text-xs text-muted ml-auto whitespace-nowrap">
            {formatTime(first.created_at)}
          </span>
        </div>
        <div className="mt-1">
          <DiffToggle
            open={open}
            onToggle={() => setOpen((o) => !o)}
            label={open ? "Hide items" : "Show items"}
          />
          {open && (
            <ul className="mt-1.5 space-y-1.5 border-l-2 border-border pl-3">
              {rows.map((r) => (
                <BatchChildRow key={r.id} row={r} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

/** A row inside an expanded batch — just the label (+ diff for updates). */
function BatchChildRow({ row }: { row: HistoryRow }) {
  const [open, setOpen] = useState(false)
  const changes = changesOf(row)

  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-semibold break-words min-w-0">
          {row.entity_label ?? "(untitled)"}
        </span>
        {changes.length > 0 && (
          <DiffToggle
            open={open}
            onToggle={() => setOpen((o) => !o)}
            label={`${changes.length} field${changes.length === 1 ? "" : "s"} changed`}
          />
        )}
      </div>
      {open && changes.length > 0 && <DiffTable changes={changes} />}
    </li>
  )
}
