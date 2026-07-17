"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Download,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Select } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { formatCurrency, formatDate, cn } from "@/lib/utils"
import { makeXlsx, type XlsxCell } from "@/lib/export/xlsx"
import {
  saveBudgetLine,
  setForecastOverride,
  removeBudgetLine,
  parseBudgetImport,
  applyBudgetImport,
  type BudgetImportPreview,
} from "@/app/actions/budget"
import { UNCODED_KEY, type BudgetRow, type BudgetTotals } from "@/lib/budget/rollup"

type CodeOption = { id: string; code: string; name: string }

// The Forecasted-remaining column carries its own tint so the one editable
// money column reads as editable at a glance. Shared by the header, body,
// and totals cells so the stripe is continuous.
const FORECAST_COL_CLASS = "bg-brand-50/70"

export function BudgetClient({
  projectId,
  projectName,
  projectNumber,
  canEdit,
  rows,
  totals,
  availableCodes,
  templateCodes,
}: {
  projectId: string
  projectName: string
  projectNumber: string
  // Budget-editors allowlist (Settings → Budget editors): false = read-only
  // view — all numbers, none of the edit affordances.
  canEdit: boolean
  rows: BudgetRow[]
  totals: BudgetTotals
  availableCodes: CodeOption[]
  templateCodes: CodeOption[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [importOpen, setImportOpen] = useState(false)

  const run = (fn: () => Promise<unknown>, done?: string) =>
    startTransition(async () => {
      try {
        await fn()
        if (done) toast.success(done)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong")
      }
    })

  const downloadXlsx = (name: string, sheets: Parameters<typeof makeXlsx>[0]) => {
    const bytes = makeXlsx(sheets)
    const blob = new Blob([bytes as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  // Import template: every active cost code, prefilled with what's already on
  // the table so a downloaded file round-trips (edit + re-import).
  const downloadTemplate = () => {
    const byId = new Map(rows.map((r) => [r.key, r]))
    const dataRows: XlsxCell[][] = templateCodes.map((c) => {
      const row = byId.get(c.id)
      return [
        c.code,
        c.name,
        row && row.hasLine ? row.budget : null,
        row && row.actuals !== 0 ? row.actuals : null,
      ]
    })
    downloadXlsx(`budget-template-${projectNumber}.xlsx`, [
      {
        name: "Budget",
        rows: [["Cost code", "Name", "Budget", "Actual costs to date"], ...dataRows],
      },
    ])
  }

  const exportTable = () => {
    const dataRows: XlsxCell[][] = rows.map((r) => [
      r.code ?? "",
      r.label.includes("—") ? r.label.split("—").slice(1).join("—").trim() : r.label,
      r.budget,
      r.changes,
      r.newBudget,
      r.actuals,
      r.pos,
      r.forecastRemaining,
      r.totalForecast,
      r.variance,
    ])
    downloadXlsx(
      `budget-${projectNumber}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      [
        {
          name: "Budget",
          rows: [
            [
              "Cost code",
              "Name",
              "Budget",
              "Changes to budget",
              "New budget",
              "Actual costs to date",
              "Purchase orders",
              "Forecasted remaining",
              "Total forecasted",
              "Variance",
            ],
            ...dataRows,
            [
              "",
              "Total",
              totals.budget,
              totals.changes,
              totals.newBudget,
              totals.actuals,
              totals.pos,
              totals.forecastRemaining,
              totals.totalForecast,
              totals.variance,
            ],
          ],
        },
      ]
    )
  }

  const latestActualsAsOf = useMemo(
    () =>
      rows.reduce<string | null>(
        (max, r) =>
          r.actualsAsOf && (!max || r.actualsAsOf > max) ? r.actualsAsOf : max,
        null
      ),
    [rows]
  )

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-lg font-semibold tracking-tight">Budget</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={downloadTemplate}>
            <FileSpreadsheet className="h-3.5 w-3.5" /> Template
          </Button>
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Import
            </Button>
          )}
          {rows.length > 0 && (
            <Button variant="secondary" size="sm" onClick={exportTable}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          )}
          {canEdit && availableCodes.length > 0 && (
            <Select
              className="w-44 h-8 text-xs"
              value=""
              aria-label="Add cost code"
              onChange={(e) => {
                const id = e.target.value
                if (!id) return
                run(
                  () =>
                    saveBudgetLine({
                      project_id: projectId,
                      cost_code_id: id,
                      budget_amount: 0,
                    })
                )
              }}
            >
              <option value="">Add cost code…</option>
              {availableCodes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCell label="New budget" value={formatCurrency(totals.newBudget)} />
        <SummaryCell
          label="Actual costs to date"
          value={formatCurrency(totals.actuals)}
          sub={latestActualsAsOf ? `as of ${formatDate(latestActualsAsOf)}` : undefined}
        />
        <SummaryCell
          label="Total forecasted"
          value={formatCurrency(totals.totalForecast)}
        />
        <SummaryCell
          label="Variance"
          value={signedCurrency(totals.variance)}
          tone={varianceTone(totals.variance)}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-8 w-8" />}
          title="No budget yet"
          description={
            canEdit
              ? "Import a budget spreadsheet, or add cost codes one at a time. Once the SpecMagician bid tool is finished, budgets will transfer from there."
              : "A budget editor can import a spreadsheet or add cost codes; you'll see the numbers here once they do."
          }
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-3.5 w-3.5" /> Import spreadsheet
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className={cn(isPending && "opacity-60 pointer-events-none")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">Cost code</th>
                  <th className="text-right px-2 py-2.5">Budget</th>
                  <th className="text-right px-2 py-2.5">Changes</th>
                  <th className="text-right px-2 py-2.5">New budget</th>
                  <th className="text-right px-2 py-2.5">Actuals</th>
                  <th className="text-right px-2 py-2.5">POs</th>
                  <th className={cn("text-right px-2 py-2.5", FORECAST_COL_CLASS)}>
                    Forecasted remaining
                  </th>
                  <th className="text-right px-2 py-2.5">Total forecasted</th>
                  <th className="text-right px-2 py-2.5">Variance</th>
                  <th className="w-8" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  // The uncoded bucket has no cost_code_id to store a line
                  // against — its budget/forecast cells are display-only.
                  // Non-editors get the same display-only treatment.
                  const editable = canEdit && r.key !== UNCODED_KEY
                  return (
                    <tr key={r.key} className="group">
                      <td className="px-4 py-1.5 whitespace-nowrap">{r.label}</td>
                      <td className="px-2 py-1.5 text-right">
                        {editable ? (
                          <MoneyCell
                            value={r.hasLine ? r.budget : null}
                            placeholder="—"
                            onSave={(n) => {
                              if (n == null) return
                              run(() =>
                                saveBudgetLine({
                                  project_id: projectId,
                                  cost_code_id: r.key,
                                  budget_amount: n,
                                })
                              )
                            }}
                          />
                        ) : (
                          // Read-only (non-editor, or the uncoded bucket):
                          // still show the number — only editing is gated.
                          <span
                            className={cn(
                              "tabular-nums",
                              !r.hasLine && "text-muted"
                            )}
                          >
                            {r.hasLine ? formatCurrency(r.budget) : "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.changes === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          signedCurrency(r.changes)
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                        {formatCurrency(r.newBudget)}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums"
                        title={
                          r.actualsAsOf
                            ? `As of ${formatDate(r.actualsAsOf)}`
                            : undefined
                        }
                      >
                        {r.actuals === 0 && !r.actualsAsOf ? (
                          <span className="text-muted">—</span>
                        ) : (
                          formatCurrency(r.actuals)
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.pos === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          formatCurrency(r.pos)
                        )}
                      </td>
                      <td className={cn("px-2 py-1.5 text-right", FORECAST_COL_CLASS)}>
                        {editable ? (
                          <MoneyCell
                            value={r.forecastRemaining}
                            overridden={r.forecastOverride != null}
                            clearable
                            onSave={(n) =>
                              run(() =>
                                setForecastOverride({
                                  project_id: projectId,
                                  cost_code_id: r.key,
                                  forecast_override: n,
                                })
                              )
                            }
                          />
                        ) : (
                          <span
                            className={cn(
                              "tabular-nums",
                              r.forecastOverride != null && "text-warning font-medium"
                            )}
                          >
                            {formatCurrency(r.forecastRemaining)}
                            {r.forecastOverride != null && " *"}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {formatCurrency(r.totalForecast)}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 text-right tabular-nums",
                          varianceClass(r.variance)
                        )}
                      >
                        {r.variance === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          signedCurrency(r.variance)
                        )}
                      </td>
                      <td className="px-1 py-1.5 text-right">
                        {canEdit && r.hasLine && (
                          <button
                            type="button"
                            className="invisible group-hover:visible rounded p-1 text-muted hover:text-danger cursor-pointer"
                            title="Remove budget line (keeps changes, actuals, and POs)"
                            onClick={() =>
                              run(() =>
                                removeBudgetLine({
                                  project_id: projectId,
                                  cost_code_id: r.key,
                                })
                              )
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                <tr className="bg-background/40 font-semibold">
                  <td className="px-4 py-2.5 text-right">Total</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {formatCurrency(totals.budget)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {signedCurrency(totals.changes)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {formatCurrency(totals.newBudget)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {formatCurrency(totals.actuals)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {formatCurrency(totals.pos)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2.5 text-right tabular-nums",
                      FORECAST_COL_CLASS
                    )}
                  >
                    {formatCurrency(totals.forecastRemaining)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {formatCurrency(totals.totalForecast)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2.5 text-right tabular-nums",
                      varianceClass(totals.variance)
                    )}
                  >
                    {signedCurrency(totals.variance)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="text-xs text-muted space-y-1">
        <p>
          <span className="font-medium text-foreground">Changes</span> roll up
          from approved selections and change orders by cost code.{" "}
          <span className="font-medium text-foreground">POs</span> are approved
          purchase orders (committed costs).
        </p>
        <p>
          <span className="font-medium text-foreground">Actual costs to date</span>{" "}
          will sync from QuickBooks Online per cost code once the QBO connection
          is live. Until then, the import spreadsheet&apos;s optional
          &quot;Actual costs&quot; column can stage them.
        </p>
        <p>
          <span className="font-medium text-foreground">Forecasted remaining</span>{" "}
          (the highlighted column) defaults to New budget − Actuals.{" "}
          {canEdit
            ? "Click a cell to set your own number (shown in amber); clear the cell to go back to the default."
            : "Amber numbers are editor overrides. The budget is read-only for you — budget editors are picked in Settings → Budget editors."}
        </p>
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
        projectName={projectName}
        onDone={() => router.refresh()}
      />
    </div>
  )
}

function signedCurrency(n: number) {
  return (n > 0 ? "+" : "") + formatCurrency(n)
}

function varianceTone(n: number): "danger" | "success" | "neutral" {
  return n > 0 ? "danger" : n < 0 ? "success" : "neutral"
}

function varianceClass(n: number) {
  return n > 0 ? "text-danger" : n < 0 ? "text-success" : undefined
}

function SummaryCell({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string
  value: string
  sub?: string
  tone?: "danger" | "success" | "neutral"
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums mt-0.5",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success"
        )}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  )
}

function parseMoneyText(raw: string): number | null | "invalid" {
  const s = raw.replace(/[$,\s]/g, "")
  if (s === "") return null
  const m = /^\((.*)\)$/.exec(s)
  const n = Number(m ? `-${m[1]}` : s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : "invalid"
}

/**
 * Click-to-edit money cell. Enter/blur saves, Escape cancels. An empty save is
 * `null` — the forecast cell uses that to clear its override (`clearable`);
 * the budget cell ignores it.
 */
function MoneyCell({
  value,
  onSave,
  overridden = false,
  clearable = false,
  placeholder = "0",
}: {
  value: number | null
  onSave: (n: number | null) => void
  overridden?: boolean
  clearable?: boolean
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = () => {
    const raw = inputRef.current?.value ?? ""
    setEditing(false)
    const n = parseMoneyText(raw)
    if (n === "invalid") {
      toast.error(`"${raw}" isn't a number`)
      return
    }
    if (n == null) {
      if (clearable && value != null && overridden) onSave(null)
      return
    }
    if (n !== value) onSave(n)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoFocus
        defaultValue={value != null ? String(value) : ""}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") setEditing(false)
        }}
        className="w-28 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={
        overridden
          ? "Manually set — clear the cell to return to the default"
          : "Click to edit"
      }
      className={cn(
        "w-full rounded px-1.5 py-0.5 text-right tabular-nums cursor-text hover:bg-background/80",
        value == null && "text-muted",
        overridden && "text-warning font-medium"
      )}
    >
      {value == null ? placeholder : formatCurrency(value)}
      {overridden && <span aria-hidden> *</span>}
    </button>
  )
}

function ImportDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  projectName: string
  onDone: () => void
}) {
  const [preview, setPreview] = useState<BudgetImportPreview | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [isParsing, startParsing] = useTransition()
  const [isApplying, startApplying] = useTransition()

  const close = (v: boolean) => {
    onOpenChange(v)
    if (!v) {
      setPreview(null)
      setFileName(null)
    }
  }

  const pickFile = (file: File | null) => {
    if (!file) return
    setFileName(file.name)
    const fd = new FormData()
    fd.set("file", file)
    startParsing(async () => {
      try {
        setPreview(await parseBudgetImport(fd))
      } catch (e) {
        setFileName(null)
        toast.error(e instanceof Error ? e.message : "Couldn't read that file")
      }
    })
  }

  const apply = () => {
    if (!preview || preview.rows.length === 0) return
    startApplying(async () => {
      try {
        const res = await applyBudgetImport({
          project_id: projectId,
          rows: preview.rows.map((r) => ({
            cost_code_id: r.cost_code_id,
            budget_amount: r.budget_amount,
            actual_amount: r.actual_amount,
          })),
        })
        toast.success(
          `Imported ${res.budgets} budget ${res.budgets === 1 ? "amount" : "amounts"}` +
            (res.actuals > 0 ? ` and ${res.actuals} actuals` : "")
        )
        close(false)
        onDone()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Import failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="lg">
        <DialogHeader>
          <div>
            <DialogTitle>Import budget</DialogTitle>
            <DialogDescription>
              {projectName} — upload the .xlsx template or a .csv with
              &quot;Cost code&quot; and &quot;Budget&quot; columns (optional
              &quot;Actual costs&quot; column until QBO is connected).
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {!preview ? (
            <label
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center cursor-pointer hover:bg-background/60",
                isParsing && "opacity-60 pointer-events-none"
              )}
            >
              {isParsing ? (
                <Loader2 className="h-6 w-6 animate-spin text-muted" />
              ) : (
                <Upload className="h-6 w-6 text-muted" />
              )}
              <span className="text-sm font-medium">
                {isParsing
                  ? `Reading ${fileName}…`
                  : "Choose a spreadsheet (.xlsx or .csv)"}
              </span>
              <span className="text-xs text-muted">
                Matching happens on the cost-code column; other rows are listed
                before anything is saved.
              </span>
              <input
                type="file"
                accept=".xlsx,.csv"
                className="sr-only"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                <span className="font-medium">{preview.rows.length}</span>{" "}
                {preview.rows.length === 1 ? "row" : "rows"} matched from{" "}
                <span className="font-medium">{fileName}</span>. Importing
                updates only these cost codes — nothing else is touched.
              </p>
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-background/60 text-xs uppercase text-muted sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2">Cost code</th>
                      <th className="text-right px-3 py-2">Budget</th>
                      {preview.hasActuals && (
                        <th className="text-right px-3 py-2">Actual costs</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.rows.map((r) => (
                      <tr key={r.cost_code_id}>
                        <td className="px-3 py-1.5">
                          {r.code} — {r.name}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {r.budget_amount != null
                            ? formatCurrency(r.budget_amount)
                            : "—"}
                        </td>
                        {preview.hasActuals && (
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {r.actual_amount != null
                              ? formatCurrency(r.actual_amount)
                              : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.skipped.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                  <p className="font-medium mb-1">
                    Skipped {preview.skipped.length}{" "}
                    {preview.skipped.length === 1 ? "row" : "rows"}:
                  </p>
                  <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                    {preview.skipped.map((s, i) => (
                      <li key={i}>
                        <span className="font-mono">{s.code}</span> — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {preview ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPreview(null)
                  setFileName(null)
                }}
              >
                Pick another file
              </Button>
              <Button
                size="sm"
                disabled={preview.rows.length === 0 || isApplying}
                onClick={apply}
              >
                {isApplying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Import {preview.rows.length}{" "}
                {preview.rows.length === 1 ? "row" : "rows"}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
