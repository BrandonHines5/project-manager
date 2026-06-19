"use client"

import { useState, useTransition, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Trash2, Receipt, DollarSign, FileDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { formatCurrency, formatDate, cn, todayISO } from "@/lib/utils"
import {
  savePayment,
  deletePayment,
  type PaymentInputT,
} from "@/app/actions/payments"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"

export type PricingData = {
  project_id: string
  project_name: string
  project_number: string
  project_address: string | null
  role: UserRole
  contract_price: number | null
  approved_decisions: Pick<
    Tables<"decisions">,
    "id" | "number" | "title" | "kind" | "cost_delta" | "status" | "approved_at"
  >[]
  payments: Tables<"project_payments">[]
  brand: { name: string; logo: string }
}

export function PricingClient({ data }: { data: PricingData }) {
  const canEdit = data.role === "staff"
  const [editPayment, setEditPayment] = useState<
    Tables<"project_payments"> | "new" | null
  >(null)

  const totals = useMemo(() => {
    const contract = Number(data.contract_price ?? 0)
    const approvedDelta = data.approved_decisions.reduce(
      (sum, d) => sum + (Number(d.cost_delta) || 0),
      0
    )
    const newTotal = contract + approvedDelta
    const paid = data.payments.reduce(
      (sum, p) => sum + (Number(p.amount) || 0),
      0
    )
    const balance = newTotal - paid
    return { contract, approvedDelta, newTotal, paid, balance }
  }, [data])

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-5 space-y-6">
      {/* Page header + PDF export */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Pricing</h1>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => window.print()}
          title="Download a PDF of this pricing page"
        >
          <FileDown className="h-3.5 w-3.5" /> Download PDF
        </Button>
      </div>

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCell label="Contract" value={formatCurrency(totals.contract)} />
        <SummaryCell
          label="Approved changes"
          value={
            (totals.approvedDelta >= 0 ? "+" : "") +
            formatCurrency(totals.approvedDelta)
          }
          tone={totals.approvedDelta > 0 ? "neutral" : "success"}
        />
        <SummaryCell
          label="New contract total"
          value={formatCurrency(totals.newTotal)}
          tone="brand"
        />
        <SummaryCell label="Paid" value={formatCurrency(totals.paid)} tone="success" />
        <SummaryCell
          label="Balance due"
          value={formatCurrency(totals.balance)}
          tone={totals.balance > 0 ? "danger" : "success"}
        />
      </div>

      {/* Approved decisions */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Approved decisions</CardTitle>
          <Link
            href={`/projects/${data.project_id}/decisions`}
            className="text-xs text-brand-600 hover:underline"
          >
            Manage decisions →
          </Link>
        </CardHeader>
        {data.approved_decisions.length === 0 ? (
          <CardBody>
            <p className="text-sm text-muted">
              No approved decisions yet. Once a change order or selection is
              approved, it&apos;ll appear here and roll into the contract total.
            </p>
          </CardBody>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-4 py-2.5 w-16">#</th>
                <th className="text-left px-4 py-2.5">Title</th>
                <th className="text-left px-4 py-2.5 w-32">Approved</th>
                <th className="text-right px-4 py-2.5 w-36">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.approved_decisions.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-2 font-mono text-xs text-muted">
                    #{d.number}
                  </td>
                  <td className="px-4 py-2">
                    <span>{d.title}</span>{" "}
                    <Badge tone="muted">
                      {d.kind === "change_order" ? "CO" : "Sel"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted">
                    {d.approved_at ? formatDate(d.approved_at) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {(d.cost_delta ?? 0) >= 0 ? "+" : ""}
                    {formatCurrency(d.cost_delta)}
                  </td>
                </tr>
              ))}
              <tr className="bg-background/40 font-semibold">
                <td colSpan={3} className="px-4 py-2.5 text-right">
                  Total approved deltas
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {(totals.approvedDelta >= 0 ? "+" : "") +
                    formatCurrency(totals.approvedDelta)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      {/* Payments */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Payments received</CardTitle>
          {canEdit && (
            <Button size="sm" onClick={() => setEditPayment("new")}>
              <Plus className="h-3.5 w-3.5" /> Record payment
            </Button>
          )}
        </CardHeader>
        {data.payments.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={<Receipt className="h-8 w-8" />}
              title="No payments recorded"
              description={
                canEdit
                  ? "Record manual payments here. QuickBooks sync will populate this list automatically in a future release."
                  : "Payments will appear here as they're recorded."
              }
            />
          </CardBody>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-4 py-2.5 w-32">Date</th>
                <th className="text-left px-4 py-2.5 w-28">Method</th>
                <th className="text-left px-4 py-2.5">Reference / notes</th>
                <th className="text-right px-4 py-2.5 w-36">Amount</th>
                {canEdit && <th className="w-12"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.payments.map((p) => (
                <tr
                  key={p.id}
                  className={canEdit ? "hover:bg-background/40 cursor-pointer" : ""}
                  onClick={canEdit ? () => setEditPayment(p) : undefined}
                >
                  <td className="px-4 py-2 text-muted">{formatDate(p.paid_on)}</td>
                  <td className="px-4 py-2 capitalize">{p.method}</td>
                  <td className="px-4 py-2">
                    <div className="text-sm">{p.reference || "—"}</div>
                    {p.notes && (
                      <div className="text-xs text-muted">{p.notes}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatCurrency(p.amount)}
                  </td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <DeleteButton id={p.id} projectId={data.project_id} />
                    </td>
                  )}
                </tr>
              ))}
              <tr className="bg-background/40 font-semibold">
                <td colSpan={3} className="px-4 py-2.5 text-right">
                  Total paid
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatCurrency(totals.paid)}
                </td>
                {canEdit && <td></td>}
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      {editPayment && canEdit && (
        <PaymentDialog
          key={editPayment === "new" ? "new" : editPayment.id}
          payment={editPayment === "new" ? null : editPayment}
          projectId={data.project_id}
          onClose={() => setEditPayment(null)}
        />
      )}

      {/* Print-only document: shown only when the browser prints / saves to PDF. */}
      <PricingPrintDocument data={data} totals={totals} />
    </div>
  )
}

// A clean, self-contained document rendered only in the print stylesheet (see
// `#pricing-print-root` rules in globals.css). It includes the project's brand
// logo so the saved PDF presents under Hines Homes or MJV Building Group.
function PricingPrintDocument({
  data,
  totals,
}: {
  data: PricingData
  totals: {
    contract: number
    approvedDelta: number
    newTotal: number
    paid: number
    balance: number
  }
}) {
  return (
    <div id="pricing-print-root">
      <div className="pp-header">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={data.brand.logo} alt={data.brand.name} className="pp-logo" />
        <div className="pp-meta">
          <div className="pp-title">Pricing Summary</div>
          <div className="pp-project">{data.project_name}</div>
          <div className="pp-sub">
            Project #{data.project_number}
            {data.project_address ? ` · ${data.project_address}` : ""}
          </div>
          <div className="pp-sub">Generated {formatDate(todayISO())}</div>
        </div>
      </div>

      <table className="pp-table">
        <tbody>
          <tr>
            <td>Contract</td>
            <td className="pp-num">{formatCurrency(totals.contract)}</td>
          </tr>
          <tr>
            <td>Approved changes</td>
            <td className="pp-num">
              {(totals.approvedDelta >= 0 ? "+" : "") +
                formatCurrency(totals.approvedDelta)}
            </td>
          </tr>
          <tr className="pp-strong">
            <td>New contract total</td>
            <td className="pp-num">{formatCurrency(totals.newTotal)}</td>
          </tr>
          <tr>
            <td>Paid</td>
            <td className="pp-num">{formatCurrency(totals.paid)}</td>
          </tr>
          <tr className="pp-strong">
            <td>Balance due</td>
            <td className="pp-num">{formatCurrency(totals.balance)}</td>
          </tr>
        </tbody>
      </table>

      <h2 className="pp-h2">Approved decisions</h2>
      {data.approved_decisions.length === 0 ? (
        <p className="pp-empty">No approved decisions.</p>
      ) : (
        <table className="pp-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Approved</th>
              <th className="pp-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.approved_decisions.map((d) => (
              <tr key={d.id}>
                <td>#{d.number}</td>
                <td>
                  {d.title} ({d.kind === "change_order" ? "CO" : "Sel"})
                </td>
                <td>{d.approved_at ? formatDate(d.approved_at) : "—"}</td>
                <td className="pp-num">
                  {(d.cost_delta ?? 0) >= 0 ? "+" : ""}
                  {formatCurrency(d.cost_delta)}
                </td>
              </tr>
            ))}
            <tr className="pp-strong">
              <td colSpan={3}>Total approved deltas</td>
              <td className="pp-num">
                {(totals.approvedDelta >= 0 ? "+" : "") +
                  formatCurrency(totals.approvedDelta)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <h2 className="pp-h2">Payments received</h2>
      {data.payments.length === 0 ? (
        <p className="pp-empty">No payments recorded.</p>
      ) : (
        <table className="pp-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Method</th>
              <th>Reference / notes</th>
              <th className="pp-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.payments.map((p) => (
              <tr key={p.id}>
                <td>{formatDate(p.paid_on)}</td>
                <td className="pp-cap">{p.method}</td>
                <td>
                  {p.reference || "—"}
                  {p.notes ? ` — ${p.notes}` : ""}
                </td>
                <td className="pp-num">{formatCurrency(p.amount)}</td>
              </tr>
            ))}
            <tr className="pp-strong">
              <td colSpan={3}>Total paid</td>
              <td className="pp-num">{formatCurrency(totals.paid)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "neutral" | "brand" | "success" | "danger"
}) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs uppercase text-muted tracking-wide flex items-center gap-1">
          <DollarSign className="h-3 w-3" /> {label}
        </div>
        <div
          className={cn(
            "text-xl font-semibold tabular-nums mt-1",
            tone === "brand" && "text-brand-700",
            tone === "success" && "text-success",
            tone === "danger" && "text-danger"
          )}
        >
          {value}
        </div>
      </CardBody>
    </Card>
  )
}

function DeleteButton({
  id,
  projectId,
}: {
  id: string
  projectId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  function handle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm("Delete this payment?")) return
    startTransition(async () => {
      try {
        await deletePayment({ id, project_id: projectId })
        toast.success("Deleted")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }
  return (
    <button
      onClick={handle}
      disabled={pending}
      className="text-muted hover:text-danger p-1 cursor-pointer"
      title="Delete"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

function PaymentDialog({
  payment,
  projectId,
  onClose,
}: {
  payment: Tables<"project_payments"> | null
  projectId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [amount, setAmount] = useState(
    payment ? String(payment.amount) : ""
  )
  const [paidOn, setPaidOn] = useState(payment?.paid_on ?? todayISO())
  const [method, setMethod] = useState<Enums<"payment_method">>(
    payment?.method ?? "check"
  )
  const [reference, setReference] = useState(payment?.reference ?? "")
  const [notes, setNotes] = useState(payment?.notes ?? "")

  function submit() {
    if (!amount || Number(amount) <= 0) {
      toast.error("Amount must be positive")
      return
    }
    const payload: PaymentInputT = {
      id: payment?.id,
      project_id: projectId,
      amount: Number(amount),
      paid_on: paidOn,
      method,
      reference: reference || null,
      notes: notes || null,
    }
    startTransition(async () => {
      try {
        await savePayment(payload)
        toast.success(payment ? "Saved" : "Recorded")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{payment ? "Edit payment" : "Record payment"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Date">
              <Input
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </Field>
            <Field label="Method">
              <Select
                value={method}
                onChange={(e) =>
                  setMethod(e.target.value as Enums<"payment_method">)
                }
              >
                <option value="check">Check</option>
                <option value="wire">Wire</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Reference">
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check #, wire ref…"
              />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
