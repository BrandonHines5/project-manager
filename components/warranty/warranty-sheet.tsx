"use client"

import { useLayoutEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Trash2, Download } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Textarea, Select } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn, formatDate, todayISO } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"
import {
  updateWarrantyItem,
  createWarrantyItem,
  deleteWarrantyItem,
} from "@/app/actions/warranty"

type Status = Enums<"schedule_item_status">
// "not_covered" is a warranty-only virtual status backed by the
// warranty_no_action flag (not a real schedule_item_status enum value).
type StatusValue = Status | "not_covered"

export type WarrantyItem = {
  id: string
  project_id: string
  title: string
  due_date: string | null
  status: Status
  warranty_date_noted: string | null
  warranty_resolution: string | null
  warranty_who_fixing: string | null
  warranty_no_action: boolean
  updated_at: string
}

export type WarrantyHome = {
  id: string
  project_number: string
  name: string
  address: string | null
  client_name: string | null
  client_name_2: string | null
  warranty_end_date: string | null
  items: WarrantyItem[]
}

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "complete", label: "Complete" },
  { value: "delayed", label: "Delayed" },
  { value: "not_covered", label: "Not covered / No action" },
]

const STATUS_LABEL: Record<StatusValue, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  delayed: "Delayed",
  not_covered: "Not covered / No action",
}

const STATUS_TONE: Record<
  StatusValue,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  not_started: "muted",
  in_progress: "info",
  complete: "success",
  delayed: "danger",
  not_covered: "muted",
}

// An item is "open" — counted and shown by default — unless it's complete or
// has been dispositioned as not-covered / no-action.
function isOpen(item: WarrantyItem): boolean {
  return item.status !== "complete" && !item.warranty_no_action
}

function statusValue(item: WarrantyItem): StatusValue {
  return item.warranty_no_action ? "not_covered" : item.status
}

function ownerName(h: WarrantyHome): string {
  const names = [h.client_name, h.client_name_2].filter(
    (n): n is string => !!n && n.trim().length > 0
  )
  return names.length ? names.join(" & ") : "—"
}

export function WarrantySheet({ homes }: { homes: WarrantyHome[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [showCompleted, setShowCompleted] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addHomeId, setAddHomeId] = useState(homes[0]?.id ?? "")

  const openCount = useMemo(
    () => homes.reduce((sum, h) => sum + h.items.filter(isOpen).length, 0),
    [homes]
  )

  // Hide homes with no open items unless the user opts to show completed.
  const visibleHomes = showCompleted
    ? homes
    : homes.filter((h) => h.items.some(isOpen))

  function exportOpenItems() {
    const headers = [
      "Address",
      "Owner Name",
      "Warranty End Date",
      "Date Noted",
      "Owner Noted Issue",
      "Resolution",
      "Who is Fixing It",
      "When Are They Fixing It",
      "Status",
    ]
    const rows: string[][] = []
    for (const h of homes) {
      for (const it of h.items) {
        if (!isOpen(it)) continue
        rows.push([
          h.address ?? "",
          ownerName(h),
          h.warranty_end_date ?? "",
          it.warranty_date_noted ?? "",
          it.title,
          it.warranty_resolution ?? "",
          it.warranty_who_fixing ?? "",
          it.due_date ?? "",
          STATUS_LABEL[statusValue(it)],
        ])
      }
    }
    if (rows.length === 0) {
      toast.info("No open warranty items to export")
      return
    }
    const csv = [headers, ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n")
    // Prepend a BOM so Excel reads UTF-8 (names, em dashes) correctly.
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8;",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `warranty-open-items-${todayISO()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function addItem() {
    if (!addHomeId) return
    startTransition(async () => {
      try {
        await createWarrantyItem({ project_id: addHomeId })
        const home = homes.find((h) => h.id === addHomeId)
        toast.success(`Added item to ${home?.address ?? "home"}`)
        setAddOpen(false)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not add item")
      }
    })
  }

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 md:-mx-6 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/95 px-4 md:px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-6 text-sm">
          <Stat label="In warranty" value={homes.length} />
          <Stat label="Open items" value={openCount} />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="h-4 w-4 rounded border-border-strong accent-brand-600"
            />
            Show completed
          </label>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={exportOpenItems}
          >
            <Download className="h-4 w-4" />
            Export open
          </Button>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add warranty item
          </Button>
        </div>
      </div>

      {visibleHomes.length === 0 ? (
        <p className="text-sm text-muted py-8 text-center">
          No open warranty items. 🎉 Toggle “Show completed” to see closed items.
        </p>
      ) : (
        <div className="space-y-5">
          {visibleHomes.map((home) => (
            <HomeCard
              key={home.id}
              home={home}
              showCompleted={showCompleted}
            />
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Add warranty item</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <label className="text-sm font-medium">Home</label>
            <Select
              value={addHomeId}
              onChange={(e) => setAddHomeId(e.target.value)}
              className="mt-1"
            >
              {homes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.address || h.name} ({h.project_number})
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted mt-2">
              A blank item is added to this home; fill in the details inline.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAddOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={addItem} disabled={pending || !addHomeId}>
              Add item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HomeCard({
  home,
  showCompleted,
}: {
  home: WarrantyHome
  showCompleted: boolean
}) {
  const visible = showCompleted ? home.items : home.items.filter(isOpen)
  const openCount = home.items.filter(isOpen).length

  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3 border-b border-border bg-background/40">
        <div className="min-w-0">
          <Link
            href={`/projects/${home.id}/schedule`}
            className="group inline-block"
          >
            <div className="font-mono text-[11px] text-muted">
              {home.project_number}
            </div>
            <div className="font-medium text-sm group-hover:text-brand-600 truncate">
              {home.address || home.name}
            </div>
          </Link>
          <div className="text-xs text-muted mt-0.5">
            Owner: {ownerName(home)}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[11px] text-muted uppercase tracking-wide">
              Warranty end
            </div>
            {/* Read-only — sourced from the CRM (completion date + 1 year). */}
            <div className="text-sm font-medium tabular-nums">
              {home.warranty_end_date ? formatDate(home.warranty_end_date) : "—"}
            </div>
          </div>
          <Badge tone={openCount ? "warning" : "success"}>
            {openCount} open
          </Badge>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-background/60 text-xs text-muted uppercase">
            <tr>
              <th className="text-left font-medium px-3 py-2 w-36">
                Date noted
              </th>
              <th className="text-left font-medium px-3 py-2">
                Owner noted issue
              </th>
              <th className="text-left font-medium px-3 py-2">Resolution</th>
              <th className="text-left font-medium px-3 py-2 w-44">
                Who is fixing it
              </th>
              <th className="text-left font-medium px-3 py-2 w-36">
                When fixing
              </th>
              <th className="text-left font-medium px-3 py-2 w-40">Status</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-4 text-sm text-muted text-center"
                >
                  No open warranty items. 🎉
                </td>
              </tr>
            ) : (
              visible.map((item) => (
                <WarrantyRow key={`${item.id}-${item.updated_at}`} item={item} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function WarrantyRow({ item }: { item: WarrantyItem }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dateNoted, setDateNoted] = useState(item.warranty_date_noted ?? "")
  const [title, setTitle] = useState(item.title)
  const [resolution, setResolution] = useState(item.warranty_resolution ?? "")
  const [whoFixing, setWhoFixing] = useState(item.warranty_who_fixing ?? "")
  const [dueDate, setDueDate] = useState(item.due_date ?? "")

  const today = todayISO()
  const overdue = !!item.due_date && item.due_date < today && isOpen(item)
  const current = statusValue(item)

  function patch(
    fields: Omit<Parameters<typeof updateWarrantyItem>[0], "id" | "project_id">,
    successMsg?: string
  ) {
    startTransition(async () => {
      try {
        await updateWarrantyItem({
          id: item.id,
          project_id: item.project_id,
          ...fields,
        })
        if (successMsg) toast.success(successMsg)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save")
      }
    })
  }

  function saveTitle() {
    const next = title.trim()
    if (!next) {
      setTitle(item.title) // required — revert empty edits
      return
    }
    if (next === item.title) return
    patch({ title: next })
  }

  function saveDateNoted() {
    const next = dateNoted || null
    if (next === (item.warranty_date_noted ?? null)) return
    patch({ warranty_date_noted: next })
  }

  function saveResolution() {
    const next = resolution.trim()
    const cur = (item.warranty_resolution ?? "").trim()
    if (next === cur) {
      if (resolution !== cur) setResolution(cur) // normalize whitespace
      return
    }
    patch({ warranty_resolution: next || null })
  }

  function saveDueDate() {
    const next = dueDate || null
    if (next === (item.due_date ?? null)) return
    patch({ due_date: next })
  }

  function handleStatus(value: StatusValue) {
    if (value === current) return
    if (value === "not_covered") {
      patch({ warranty_no_action: true })
    } else {
      patch({ status: value, warranty_no_action: false })
    }
  }

  function saveWhoFixing() {
    const next = whoFixing.trim()
    const cur = (item.warranty_who_fixing ?? "").trim()
    if (next === cur) {
      if (whoFixing !== cur) setWhoFixing(cur) // normalize whitespace
      return
    }
    patch({ warranty_who_fixing: next || null })
  }

  function handleDelete() {
    if (!confirm("Delete this warranty item? This can't be undone.")) return
    startTransition(async () => {
      try {
        await deleteWarrantyItem({ id: item.id, project_id: item.project_id })
        toast.success("Warranty item deleted")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete")
      }
    })
  }

  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <Input
          type="date"
          value={dateNoted}
          disabled={pending}
          onChange={(e) => setDateNoted(e.target.value)}
          onBlur={saveDateNoted}
          className="h-8"
        />
      </td>
      <td className="px-3 py-2 min-w-[18rem]">
        <AutoTextarea
          value={title}
          disabled={pending}
          placeholder="Describe the owner's issue…"
          onValueChange={setTitle}
          onBlur={saveTitle}
        />
      </td>
      <td className="px-3 py-2 min-w-[20rem]">
        <AutoTextarea
          value={resolution}
          disabled={pending}
          placeholder="Resolution / plan…"
          onValueChange={setResolution}
          onBlur={saveResolution}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          value={whoFixing}
          disabled={pending}
          placeholder="e.g. Lloyd"
          className="h-8"
          onChange={(e) => setWhoFixing(e.target.value)}
          onBlur={saveWhoFixing}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="date"
          value={dueDate}
          disabled={pending}
          onChange={(e) => setDueDate(e.target.value)}
          onBlur={saveDueDate}
          className={cn("h-8", overdue && "border-danger text-danger")}
        />
        {overdue && (
          <div className="text-[11px] text-danger font-medium mt-0.5">
            Overdue
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <Select
          value={current}
          disabled={pending}
          onChange={(e) => handleStatus(e.target.value as StatusValue)}
          className="h-8"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <div className="mt-1">
          <Badge tone={STATUS_TONE[current]}>{STATUS_LABEL[current]}</Badge>
        </div>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={handleDelete}
          disabled={pending}
          className="text-muted hover:text-danger cursor-pointer disabled:opacity-50"
          title="Delete warranty item"
          aria-label="Delete warranty item"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

// Textarea that grows to fit its content so long text (issue / resolution) is
// fully visible without an inner scrollbar.
function AutoTextarea({
  value,
  onValueChange,
  onBlur,
  disabled,
  placeholder,
}: {
  value: string
  onValueChange: (v: string) => void
  onBlur: () => void
  disabled?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <Textarea
      ref={ref}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      rows={2}
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={onBlur}
      className="min-h-[40px] resize-none overflow-hidden"
    />
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
