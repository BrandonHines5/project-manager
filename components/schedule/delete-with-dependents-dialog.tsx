"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { AlertTriangle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/input"
import { deleteScheduleItem } from "@/app/actions/schedule"
import type {
  SchedulePredecessorDependent,
} from "@/app/actions/schedule"
import type { Tables, Enums } from "@/lib/db/types"

type Choice = {
  successor_id: string
  successor_title: string
  dep_type: Enums<"dependency_type">
  lag_days: number
  new_predecessor_id: "" | "REMOVE" | string
}

/**
 * Modal shown when the user tries to delete a work item that has other items
 * depending on it. Forces an explicit choice per dependent: pick a new
 * predecessor, or remove the dependency. Submit calls deleteScheduleItem
 * with the reassignments payload.
 */
export function DeleteWithDependentsDialog({
  open,
  onClose,
  onDeleted,
  itemId,
  itemTitle,
  projectId,
  dependents,
  candidatePredecessors,
}: {
  open: boolean
  onClose: () => void
  onDeleted: () => void
  itemId: string
  itemTitle: string
  projectId: string
  dependents: SchedulePredecessorDependent[]
  candidatePredecessors: Pick<Tables<"schedule_items">, "id" | "title">[]
}) {
  const [choices, setChoices] = useState<Choice[]>(() =>
    dependents.map((d) => ({
      successor_id: d.successor_id,
      successor_title: d.successor_title,
      dep_type: d.dep_type,
      lag_days: d.lag_days,
      new_predecessor_id: "",
    }))
  )
  const [pending, startTransition] = useTransition()

  const allChosen = choices.every((c) => c.new_predecessor_id !== "")

  function update(i: number, val: Choice["new_predecessor_id"]) {
    setChoices((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, new_predecessor_id: val } : c))
    )
  }

  function confirm() {
    if (!allChosen) {
      toast.error("Pick a new predecessor or remove for every dependent.")
      return
    }
    startTransition(async () => {
      try {
        await deleteScheduleItem({
          id: itemId,
          project_id: projectId,
          reassignments: choices.map((c) => ({
            successor_id: c.successor_id,
            new_predecessor_id:
              c.new_predecessor_id === "REMOVE" ? null : c.new_predecessor_id,
            dep_type: c.dep_type,
            lag_days: c.lag_days,
          })),
        })
        toast.success("Deleted")
        onDeleted()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <DialogTitle>Reassign predecessors before deleting</DialogTitle>
              <DialogDescription>
                <strong>{itemTitle}</strong> is a predecessor for{" "}
                {dependents.length} other item
                {dependents.length === 1 ? "" : "s"}. Pick a new predecessor
                for each, or remove the dependency.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y divide-border border border-border rounded-md">
            {choices.map((c, i) => (
              <li key={c.successor_id} className="p-3 space-y-1.5">
                <div className="text-sm font-medium">{c.successor_title}</div>
                <div className="text-xs text-muted">
                  was {c.dep_type}
                  {c.lag_days !== 0 ? ` (${c.lag_days}d lag)` : ""}
                </div>
                <Select
                  value={c.new_predecessor_id}
                  onChange={(e) =>
                    update(i, e.target.value as Choice["new_predecessor_id"])
                  }
                  aria-label={`Choose action for ${c.successor_title}`}
                >
                  <option value="">— choose —</option>
                  <option value="REMOVE">Remove dependency (no predecessor)</option>
                  {candidatePredecessors
                    .filter((p) => p.id !== c.successor_id && p.id !== itemId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        Use &ldquo;{p.title}&rdquo; instead
                      </option>
                    ))}
                </Select>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={pending || !allChosen}
            className="bg-danger hover:bg-red-700"
          >
            {pending ? "Deleting…" : "Confirm & delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
