"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { duplicateProject } from "@/app/actions/projects"

/**
 * Duplicate-project trigger + dialog. Lives in the project header for any
 * staff user. Use case: maintain a "template" project (standard Hines Homes
 * build schedule) and clone it per new build.
 *
 * Copies: schedule items + checklists + predecessors + the project shell
 *   (address, contract price, notes).
 * Skips: assignments, decisions, daily logs, files, payments, members.
 *
 * If a new start date is provided, all schedule dates shift by the same
 * delta so the relative cadence of the template is preserved.
 */
export function DuplicateProjectButton({
  sourceProjectId,
  sourceName,
  sourceProjectNumber,
}: {
  sourceProjectId: string
  sourceName: string
  sourceProjectNumber: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground cursor-pointer"
        title="Duplicate this project (use as template)"
      >
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </button>
      {open && (
        <DuplicateDialog
          sourceProjectId={sourceProjectId}
          sourceName={sourceName}
          sourceProjectNumber={sourceProjectNumber}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function DuplicateDialog({
  sourceProjectId,
  sourceName,
  sourceProjectNumber,
  onClose,
}: {
  sourceProjectId: string
  sourceName: string
  sourceProjectNumber: string
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [newNumber, setNewNumber] = useState("")
  const [newName, setNewName] = useState(`${sourceName} (copy)`)
  const [newStartDate, setNewStartDate] = useState("")

  function submit() {
    if (!newNumber.trim()) {
      toast.error("New project number is required")
      return
    }
    startTransition(async () => {
      try {
        const result = await duplicateProject({
          source_project_id: sourceProjectId,
          new_project_number: newNumber.trim(),
          new_name: newName.trim() || `${sourceName} (copy)`,
          new_start_date: newStartDate || null,
        })
        toast.success(
          `Created · ${result.itemsCopied} schedule item${result.itemsCopied === 1 ? "" : "s"}, ${result.predecessorsCopied} predecessor link${result.predecessorsCopied === 1 ? "" : "s"}`
        )
        router.push(`/projects/${result.id}/schedule`)
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Duplicate failed")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>Duplicate &ldquo;{sourceName}&rdquo;</DialogTitle>
            <DialogDescription>
              Copies the schedule (work items, to-dos, checklists, and
              predecessor links) plus the project shell. Assignments,
              decisions, daily logs, files, and payments are NOT copied —
              those are project-specific.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field
            label="New project number"
            hint={`Must be unique. Source is #${sourceProjectNumber}.`}
          >
            <Input
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="e.g. 2026-002"
              autoFocus
            />
          </Field>
          <Field label="New project name">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Field
            label="New start date (optional)"
            hint="If set, all schedule dates shift by the same number of days so the template's cadence is preserved. Leave blank to copy dates verbatim."
          >
            <Input
              type="date"
              value={newStartDate}
              onChange={(e) => setNewStartDate(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Duplicating…" : "Duplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
