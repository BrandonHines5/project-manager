"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input, Textarea, Select } from "@/components/ui/input"
import { cn, todayISO } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"
import {
  updateWarrantyItem,
  createWarrantyItem,
  deleteWarrantyItem,
  updateProjectWarrantyEnd,
} from "@/app/actions/warranty"

type Status = Enums<"schedule_item_status">

export type WarrantyItem = {
  id: string
  project_id: string
  title: string
  due_date: string | null
  status: Status
  warranty_date_noted: string | null
  warranty_resolution: string | null
  warranty_who_fixing: string | null
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

const STATUSES: Status[] = ["not_started", "in_progress", "complete", "delayed"]

const STATUS_LABEL: Record<Status, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  delayed: "Delayed",
}

const STATUS_TONE: Record<
  Status,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  not_started: "muted",
  in_progress: "info",
  complete: "success",
  delayed: "danger",
}

function ownerName(h: WarrantyHome): string {
  const names = [h.client_name, h.client_name_2].filter(
    (n): n is string => !!n && n.trim().length > 0
  )
  return names.length ? names.join(" & ") : "—"
}

export function WarrantySheet({ homes }: { homes: WarrantyHome[] }) {
  const [showCompleted, setShowCompleted] = useState(false)

  const openCount = useMemo(
    () =>
      homes.reduce(
        (sum, h) => sum + h.items.filter((i) => i.status !== "complete").length,
        0
      ),
    [homes]
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-6 text-sm">
          <Stat label="In warranty" value={homes.length} />
          <Stat label="Open items" value={openCount} />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong accent-brand-600"
          />
          Show completed
        </label>
      </div>

      <div className="space-y-5">
        {homes.map((home) => (
          <HomeCard
            key={`${home.id}-${home.warranty_end_date ?? ""}`}
            home={home}
            showCompleted={showCompleted}
          />
        ))}
      </div>
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
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Seeded from props; the parent remounts this card (key includes
  // warranty_end_date) when the persisted value changes, reseeding cleanly.
  const [warrantyEnd, setWarrantyEnd] = useState(home.warranty_end_date ?? "")

  const visible = showCompleted
    ? home.items
    : home.items.filter((i) => i.status !== "complete")
  const openCount = home.items.filter((i) => i.status !== "complete").length

  function saveWarrantyEnd() {
    const next = warrantyEnd || null
    if (next === (home.warranty_end_date ?? null)) return
    startTransition(async () => {
      try {
        await updateProjectWarrantyEnd({
          project_id: home.id,
          warranty_end_date: next,
        })
        toast.success("Warranty end date saved")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save")
      }
    })
  }

  function addItem() {
    startTransition(async () => {
      try {
        await createWarrantyItem({ project_id: home.id })
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not add item")
      }
    })
  }

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
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">
              Warranty end
            </div>
            <Input
              type="date"
              value={warrantyEnd}
              disabled={pending}
              onChange={(e) => setWarrantyEnd(e.target.value)}
              onBlur={saveWarrantyEnd}
              className="h-8 w-40"
            />
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
              <th className="text-left font-medium px-3 py-2 w-36">Status</th>
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
                  {home.items.length === 0
                    ? "No warranty items yet."
                    : "No open warranty items. 🎉"}
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

      <div className="px-3 py-2 border-t border-border">
        <button
          type="button"
          onClick={addItem}
          disabled={pending}
          className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 cursor-pointer disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add warranty item
        </button>
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
  const overdue =
    !!item.due_date && item.due_date < today && item.status !== "complete"

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
    const current = (item.warranty_resolution ?? "").trim()
    if (next === current) {
      if (resolution !== current) setResolution(current) // normalize whitespace
      return
    }
    patch({ warranty_resolution: next || null })
  }

  function saveDueDate() {
    const next = dueDate || null
    if (next === (item.due_date ?? null)) return
    patch({ due_date: next })
  }

  function handleStatus(status: Status) {
    if (status === item.status) return
    patch({ status })
  }

  function saveWhoFixing() {
    const next = whoFixing.trim()
    const current = (item.warranty_who_fixing ?? "").trim()
    if (next === current) {
      if (whoFixing !== current) setWhoFixing(current) // normalize whitespace
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
      <td className="px-3 py-2 min-w-[16rem]">
        <Textarea
          value={title}
          disabled={pending}
          rows={2}
          placeholder="Describe the owner's issue…"
          className="min-h-[40px]"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
        />
      </td>
      <td className="px-3 py-2 min-w-[16rem]">
        <Textarea
          value={resolution}
          disabled={pending}
          rows={2}
          placeholder="Resolution / plan…"
          className="min-h-[40px]"
          onChange={(e) => setResolution(e.target.value)}
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
          value={item.status}
          disabled={pending}
          onChange={(e) => handleStatus(e.target.value as Status)}
          className="h-8"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <div className="mt-1">
          <Badge tone={STATUS_TONE[item.status]}>
            {STATUS_LABEL[item.status]}
          </Badge>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted uppercase tracking-wide">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  )
}
