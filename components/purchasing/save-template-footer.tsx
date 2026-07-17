"use client"

import { useState } from "react"
import { BookmarkPlus } from "lucide-react"
import { DialogFooter } from "@/components/ui/dialog"
import { Input, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

/**
 * Inline footer (not a nested Dialog — see CopyBidFooter) for saving the
 * current bid/PO form as an org-wide purchasing template. The caller builds
 * the template payload from its live form state; this footer only collects
 * the template name.
 */
export function SaveTemplateFooter({
  defaultName,
  pending,
  onCancel,
  onSave,
}: {
  defaultName: string
  pending: boolean
  onCancel: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(defaultName)
  return (
    <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <Label className="mb-1">Save as template — name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Framing labor scope"
        />
        <p className="mt-1 text-[11px] text-muted">
          Templates are org-wide and can start either a bid request or a PO.
        </p>
      </div>
      <div className="flex items-center gap-2 sm:self-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => onSave(name.trim())}
          disabled={pending || !name.trim()}
        >
          <BookmarkPlus className="h-4 w-4" />
          {pending ? "Saving…" : "Save template"}
        </Button>
      </div>
    </DialogFooter>
  )
}
