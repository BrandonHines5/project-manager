"use client"

import { useLayoutEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Trash2, Download, RefreshCw } from "lucide-react"
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
import {
  updateRentalItem,
  createRentalItem,
  deleteRentalItem,
  syncRentalsFromCrm,
} from "@/app/actions/rentals"

type Status = Enums<"schedule_item_status">
type StatusValue = Status | "not_covered"
export type TrackerKind = "warranty" | "rental"

export type TrackerItem = {
  id: string
  kind: TrackerKind
  card_id: string // home (project) id or rental_property id
  title: string
  date_noted: string | null
  resolution: string | null
  who_fixing: string | null
  due_date: string | null
  status: Status
  no_action: boolean
  updated_at: string
}

export type TrackerCard = {
  id: string
  kind: TrackerKind
  number: string | null
  address: string
  subtitle: string
  warranty_end_date: string | null
  href: string | null
  items: TrackerItem[]
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

// Status filter options (drives the default "open only" behaviour).
const FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "open", label: "Open items" },
  { value: "all", label: "All statuses" },
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "delayed", label: "Delayed" },
  { value: "complete", label: "Complete" },
  { value: "not_covered", label: "Not covered / No action" },
]

function isOpen(item: TrackerItem): boolean {
  return item.status !== "complete" && !item.no_action
}

function statusValue(item: TrackerItem): StatusValue {
  return item.no_action ? "not_covered" : item.status
}

function matchesStatusFilter(item: TrackerItem, filter: string): boolean {
  switch (filter) {
    case "all":
      return true
    case "open":
      return isOpen(item)
    case "not_covered":
      return item.no_action
    case "complete":
      return item.status === "complete" && !item.no_action
    default:
      return item.status === filter && !item.no_action
  }
}

export function WarrantySheet({ cards }: { cards: TrackerCard[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [typeFilter, setTypeFilter] = useState<"all" | TrackerKind>("all")
  const [statusFilter, setStatusFilter] = useState("open")
  const [whoFilter, setWhoFilter] = useState("all")
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<TrackerKind>("warranty")
  const [addCardId, setAddCardId] = useState("")

  // Distinct "who is fixing it" values across the type-filtered cards.
  const whoOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of cards) {
      if (typeFilter !== "all" && c.kind !== typeFilter) continue
      for (const it of c.items) {
        const w = (it.who_fixing ?? "").trim()
        if (w) set.add(w)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [cards, typeFilter])

  function itemPasses(item: TrackerItem): boolean {
    if (!matchesStatusFilter(item, statusFilter)) return false
    if (whoFilter !== "all" && (item.who_fixing ?? "").trim() !== whoFilter)
      return false
    return true
  }

  const visibleCards = cards
    .filter((c) => typeFilter === "all" || c.kind === typeFilter)
    .map((c) => ({ card: c, items: c.items.filter(itemPasses) }))
    .filter((x) => x.items.length > 0)

  const warrantyCount = cards.filter((c) => c.kind === "warranty").length
  const rentalCount = cards.filter((c) => c.kind === "rental").length
  const openCount = cards.reduce(
    (sum, c) => sum + c.items.filter(isOpen).length,
    0
  )

  const addCards = cards.filter((c) => c.kind === addKind)

  function exportItems() {
    const headers = [
      "Type",
      "Address",
      "Owner / Tenant",
      "Warranty End Date",
      "Date Noted",
      "Noted Issue",
      "Resolution",
      "Who is Fixing It",
      "When Are They Fixing It",
      "Status",
    ]
    const rows: string[][] = []
    for (const { card, items } of visibleCards) {
      for (const it of items) {
        rows.push([
          card.kind === "warranty" ? "Warranty" : "Rental",
          card.address,
          card.subtitle.replace(/^(Owner|Tenant): /, ""),
          card.warranty_end_date ?? "",
          it.date_noted ?? "",
          it.title,
          it.resolution ?? "",
          it.who_fixing ?? "",
          it.due_date ?? "",
          STATUS_LABEL[statusValue(it)],
        ])
      }
    }
    if (rows.length === 0) {
      toast.info("No items to export for the current filters")
      return
    }
    const csv = [headers, ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n")
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8;",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `warranty-rental-${todayISO()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function addItem() {
    if (!addCardId) return
    startTransition(async () => {
      try {
        if (addKind === "warranty") {
          await createWarrantyItem({ project_id: addCardId })
        } else {
          await createRentalItem({ rental_property_id: addCardId })
        }
        const card = cards.find((c) => c.id === addCardId)
        toast.success(`Added item to ${card?.address ?? "property"}`)
        setAddOpen(false)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not add item")
      }
    })
  }

  function syncRentals() {
    startTransition(async () => {
      try {
        const res = await syncRentalsFromCrm()
        if (res.ok) {
          toast.success(`Synced ${res.synced} rental properties from CRM`)
          router.refresh()
        } else {
          toast.error(res.error)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Sync failed")
      }
    })
  }

  function openAdd() {
    const kind: TrackerKind = typeFilter === "rental" ? "rental" : "warranty"
    setAddKind(kind)
    setAddCardId(cards.find((c) => c.kind === kind)?.id ?? "")
    setAddOpen(true)
  }

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 md:-mx-6 mb-5 border-b border-border bg-background/95 px-4 md:px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-6 text-sm">
            <Stat label="Warranty" value={warrantyCount} />
            <Stat label="Rentals" value={rentalCount} />
            <Stat label="Open items" value={openCount} />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={syncRentals}
              disabled={pending}
              title="Refresh rental properties from the CRM"
            >
              <RefreshCw className="h-4 w-4" />
              Sync rentals
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={exportItems}
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
            <Button type="button" size="sm" onClick={openAdd}>
              <Plus className="h-4 w-4" />
              Add item
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Type"
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as "all" | TrackerKind)}
            options={[
              { value: "all", label: "Warranty + Rentals" },
              { value: "warranty", label: "Warranty only" },
              { value: "rental", label: "Rentals only" },
            ]}
          />
          <FilterSelect
            label="Status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={FILTER_OPTIONS}
          />
          <FilterSelect
            label="Who is fixing"
            value={whoFilter}
            onChange={setWhoFilter}
            options={[
              { value: "all", label: "Anyone" },
              ...whoOptions.map((w) => ({ value: w, label: w })),
            ]}
          />
        </div>
      </div>

      {visibleCards.length === 0 ? (
        <p className="text-sm text-muted py-8 text-center">
          No items match the current filters.
        </p>
      ) : (
        <div className="space-y-5">
          {visibleCards.map(({ card, items }) => (
            <TrackerCardView key={card.id} card={card} items={items} />
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Add item</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <label className="text-sm font-medium">Type</label>
            <Select
              value={addKind}
              onChange={(e) => {
                const k = e.target.value as TrackerKind
                setAddKind(k)
                setAddCardId(cards.find((c) => c.kind === k)?.id ?? "")
              }}
              className="mt-1 mb-3"
            >
              <option value="warranty">Warranty</option>
              <option value="rental">Rental</option>
            </Select>
            <label className="text-sm font-medium">
              {addKind === "warranty" ? "Home" : "Rental property"}
            </label>
            <Select
              value={addCardId}
              onChange={(e) => setAddCardId(e.target.value)}
              className="mt-1"
            >
              {addCards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.address}
                  {c.number ? ` (${c.number})` : ""}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted mt-2">
              A blank item is added; fill in the details inline.
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
            <Button
              type="button"
              onClick={addItem}
              disabled={pending || !addCardId}
            >
              Add item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TrackerCardView({
  card,
  items,
}: {
  card: TrackerCard
  items: TrackerItem[]
}) {
  const openCount = card.items.filter(isOpen).length
  const header =
    card.kind === "warranty" ? (
      <Link href={card.href ?? "#"} className="group inline-block">
        <div className="font-mono text-[11px] text-muted">{card.number}</div>
        <div className="font-medium text-sm group-hover:text-brand-600 truncate">
          {card.address}
        </div>
      </Link>
    ) : (
      <div>
        <div className="font-mono text-[11px] text-muted">Rental</div>
        <div className="font-medium text-sm truncate">{card.address}</div>
      </div>
    )

  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3 border-b border-border bg-brand-100">
        <div className="min-w-0">
          {header}
          <div className="text-xs text-muted mt-0.5">{card.subtitle}</div>
        </div>
        <div className="flex items-center gap-4">
          {card.kind === "warranty" && (
            <div className="text-right">
              <div className="text-[11px] text-muted uppercase tracking-wide">
                Warranty end
              </div>
              {/* Read-only — sourced from the CRM. */}
              <div className="text-sm font-medium tabular-nums">
                {card.warranty_end_date
                  ? formatDate(card.warranty_end_date)
                  : "—"}
              </div>
            </div>
          )}
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
                Noted issue
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
            {items.map((item) => (
              <TrackerRow key={`${item.id}-${item.updated_at}`} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

type ItemPatch = Partial<{
  title: string
  date_noted: string | null
  resolution: string | null
  who_fixing: string | null
  due_date: string | null
  status: Status
  no_action: boolean
}>

function dispatchPatch(item: TrackerItem, patch: ItemPatch) {
  if (item.kind === "warranty") {
    const w: Parameters<typeof updateWarrantyItem>[0] = {
      id: item.id,
      project_id: item.card_id,
    }
    if ("title" in patch) w.title = patch.title
    if ("date_noted" in patch) w.warranty_date_noted = patch.date_noted
    if ("resolution" in patch) w.warranty_resolution = patch.resolution
    if ("who_fixing" in patch) w.warranty_who_fixing = patch.who_fixing
    if ("due_date" in patch) w.due_date = patch.due_date
    if ("status" in patch) w.status = patch.status
    if ("no_action" in patch) w.warranty_no_action = patch.no_action
    return updateWarrantyItem(w)
  }
  return updateRentalItem({ id: item.id, ...patch })
}

function TrackerRow({ item }: { item: TrackerItem }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dateNoted, setDateNoted] = useState(item.date_noted ?? "")
  const [title, setTitle] = useState(item.title)
  const [resolution, setResolution] = useState(item.resolution ?? "")
  const [whoFixing, setWhoFixing] = useState(item.who_fixing ?? "")
  const [dueDate, setDueDate] = useState(item.due_date ?? "")

  const today = todayISO()
  const overdue = !!item.due_date && item.due_date < today && isOpen(item)
  const current = statusValue(item)

  function patch(fields: ItemPatch) {
    startTransition(async () => {
      try {
        await dispatchPatch(item, fields)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save")
      }
    })
  }

  function saveTitle() {
    const next = title.trim()
    if (!next) {
      setTitle(item.title)
      return
    }
    if (next === item.title) return
    patch({ title: next })
  }

  function saveDateNoted() {
    const next = dateNoted || null
    if (next === (item.date_noted ?? null)) return
    patch({ date_noted: next })
  }

  function saveResolution() {
    const next = resolution.trim()
    const cur = (item.resolution ?? "").trim()
    if (next === cur) {
      if (resolution !== cur) setResolution(cur)
      return
    }
    patch({ resolution: next || null })
  }

  function saveDueDate() {
    const next = dueDate || null
    if (next === (item.due_date ?? null)) return
    patch({ due_date: next })
  }

  function saveWhoFixing() {
    const next = whoFixing.trim()
    const cur = (item.who_fixing ?? "").trim()
    if (next === cur) {
      if (whoFixing !== cur) setWhoFixing(cur)
      return
    }
    patch({ who_fixing: next || null })
  }

  function handleStatus(value: StatusValue) {
    if (value === current) return
    if (value === "not_covered") {
      patch({ no_action: true })
    } else {
      patch({ status: value, no_action: false })
    }
  }

  function handleDelete() {
    if (!confirm("Delete this item? This can't be undone.")) return
    startTransition(async () => {
      try {
        if (item.kind === "warranty") {
          await deleteWarrantyItem({ id: item.id, project_id: item.card_id })
        } else {
          await deleteRentalItem({ id: item.id })
        }
        toast.success("Item deleted")
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
          placeholder="Describe the issue…"
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
          title="Delete item"
          aria-label="Delete item"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span className="uppercase tracking-wide">{label}</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-auto text-sm text-foreground"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  )
}

function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

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
