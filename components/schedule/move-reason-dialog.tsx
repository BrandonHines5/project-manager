"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Select, Textarea } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { MoveReasonT } from "@/app/actions/schedule"
import { DEFAULT_DELAY_REASONS, type DelayReason } from "@/lib/delays"

// Fallback list for callers that don't pass a configured set (e.g. the bulk
// bar before its data loads). The real list is staff-editable in
// Settings → Delay reasons and threaded in via the `reasons` prop.
export const MOVE_REASON_OPTIONS: DelayReason[] = DEFAULT_DELAY_REASONS

/**
 * Small blocking popup shown whenever a work item's dates change on a
 * baselined schedule. The chosen reason + notes land in schedule_delays, so
 * the Delay Report explains every slip against the locked plan.
 *
 * Mount it conditionally (`{pendingMove && <MoveReasonDialog …>}`) — state
 * initializes per mount, so each move starts with a fresh form.
 */
export function MoveReasonDialog({
  open,
  description,
  reasons = MOVE_REASON_OPTIONS,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean
  /** What's moving, e.g. "Framing · Jul 10 – Jul 24 → Jul 17 – Jul 31". */
  description?: string | null
  /** Staff-editable delay reasons (Settings → Delay reasons). */
  reasons?: DelayReason[]
  pending?: boolean
  onConfirm: (reason: MoveReasonT) => void
  onCancel: () => void
}) {
  const [category, setCategory] = useState<string>(
    reasons[0]?.value ?? "other"
  )
  const [notes, setNotes] = useState("")

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <div>
            <DialogTitle>Why is this moving?</DialogTitle>
            <DialogDescription>
              The baseline is locked — date changes are tracked with a reason.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {description ? (
            <p className="text-sm text-foreground bg-background/60 border border-border rounded-md px-3 py-2">
              {description}
            </p>
          ) : null}
          <Field label="Reason">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {reasons.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Additional information (optional)">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. Rain days Mon–Wed, crew back Thursday"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel move
          </Button>
          <Button
            onClick={() =>
              onConfirm({ reason_category: category, notes: notes || null })
            }
            disabled={pending}
          >
            {pending ? "Saving…" : "Save move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
