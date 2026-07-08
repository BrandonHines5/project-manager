"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Info, Plus, Trash2 } from "lucide-react"
import { Card, CardBody } from "@/components/ui/card"
import { Field, Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { saveDelayReasons } from "@/app/actions/settings"
import { slugifyReason, type DelayReason } from "@/lib/delays"

type Row = { value: string; label: string }

/**
 * Editor for the schedule delay-reason list (Settings → Delay reasons). Each
 * reason has a stable `value` (the slug written to schedule_delays) and an
 * editable `label`. Renaming touches only the label so historical delays keep
 * their reason; removing a reason leaves old entries intact (the Delay Report
 * humanizes any orphaned value).
 */
export function DelayReasonsSettingsClient({
  initialReasons,
}: {
  initialReasons: DelayReason[]
}) {
  const [rows, setRows] = useState<Row[]>(initialReasons)
  const [newLabel, setNewLabel] = useState("")
  const [pending, startTransition] = useTransition()

  function addRow() {
    const label = newLabel.trim()
    if (!label) return
    const value = slugifyReason(label)
    if (!value) {
      toast.error("Enter a reason with at least one letter or number.")
      return
    }
    if (rows.some((r) => r.value === value)) {
      toast.error(`"${label}" already exists.`)
      return
    }
    setRows((cur) => [...cur, { value, label }])
    setNewLabel("")
  }

  function renameRow(value: string, label: string) {
    setRows((cur) => cur.map((r) => (r.value === value ? { ...r, label } : r)))
  }

  function removeRow(value: string) {
    setRows((cur) => cur.filter((r) => r.value !== value))
  }

  function save() {
    const cleaned = rows
      .map((r) => ({ value: r.value, label: r.label.trim() }))
      .filter((r) => r.label)
    if (cleaned.length === 0) {
      toast.error("Keep at least one delay reason.")
      return
    }
    startTransition(async () => {
      const res = await saveDelayReasons({ reasons: cleaned })
      if (res.ok) {
        setRows(res.reasons)
        toast.success("Delay reasons saved")
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">
        Delay reasons
      </h1>
      <p className="text-sm text-muted mb-5">
        The reasons staff choose from when a baselined work item&apos;s dates
        change or a delay is logged. They also group the Delay Report.
      </p>

      <div className="mb-4 flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          Renaming a reason keeps every past delay pointing at it. Removing one
          leaves old entries as-is — they just show their original name on the
          Delay Report.
        </span>
      </div>

      <Card>
        <CardBody className="space-y-2">
          {rows.length === 0 ? (
            <p className="text-sm text-muted py-2">
              No reasons yet — add one below.
            </p>
          ) : (
            rows.map((r) => (
              <div key={r.value} className="flex items-center gap-2">
                <Input
                  value={r.label}
                  onChange={(e) => renameRow(r.value, e.target.value)}
                  aria-label={`Reason name (${r.value})`}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(r.value)}
                  aria-label={`Remove ${r.label}`}
                  className="text-muted hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <div className="mt-4">
        <Field label="Add a reason">
          <div className="flex items-center gap-2">
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addRow()
                }
              }}
              placeholder="e.g. Inspection failed"
              className="flex-1"
            />
            <Button variant="secondary" onClick={addRow} disabled={!newLabel.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </Field>
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save reasons"}
        </Button>
      </div>
    </div>
  )
}
