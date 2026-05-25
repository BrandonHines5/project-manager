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
 * staff user, AND is reused from the New Project page's "Start from
 * template" flow (see DuplicateDialog export below).
 *
 * Copies: project shell (address, contract price, notes), schedule items
 *   + checklists + predecessors, decisions (with cost-code breakdowns,
 *   follow-up templates, and attachments). Status is reset to draft on
 *   each decision and storage objects are copied to fresh paths under
 *   the new project.
 * Skips: schedule assignments, daily logs, project_files, payments,
 *   project_members, decision_comments.
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

export function DuplicateDialog({
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
        // Build a concise multi-line toast so staff can confirm everything
        // they expected to copy actually came across. Each line is only
        // shown when its count is non-zero so we don't surface "0 decisions"
        // on schedule-only templates.
        const parts = [
          `${result.itemsCopied} schedule item${result.itemsCopied === 1 ? "" : "s"}`,
          result.predecessorsCopied > 0 &&
            `${result.predecessorsCopied} predecessor link${result.predecessorsCopied === 1 ? "" : "s"}`,
          result.decisionsCopied > 0 &&
            `${result.decisionsCopied} decision${result.decisionsCopied === 1 ? "" : "s"}`,
        ].filter(Boolean)
        toast.success(`Created · ${parts.join(", ")}`)
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
              Copies the schedule (work items, to-dos, checklists, predecessor
              links) AND decisions (selections + change orders, with cost
              breakdowns, follow-up templates, and attachments). Decisions are
              reset to draft. Assignments, daily logs, project files, and
              payments are NOT copied — those are project-specific.
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
