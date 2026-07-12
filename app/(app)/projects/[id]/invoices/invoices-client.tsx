"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ExternalLink, Link2, ReceiptText, RefreshCw, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  linkProjectQboCustomer,
  searchQboCustomers,
  syncProjectInvoices,
  unlinkProjectQboCustomer,
  type QboCustomerHit,
} from "@/app/actions/invoices"
import { formatCurrency, formatDate, todayISO } from "@/lib/utils"
import type { Tables } from "@/lib/db/types"

type Invoice = Tables<"qbo_invoices">

/**
 * The Invoices tab — QBO hybrid. QuickBooks creates the invoice, emails the
 * client, and takes the payment on Intuit's hosted page; this tab is the
 * always-current mirror of it inside the portal. Clients see their open/paid
 * invoices with a "View & pay" link; staff additionally manage the QBO
 * customer link and can force a re-sync.
 */
export function InvoicesClient({
  projectId,
  isStaff,
  linkedCustomer,
  invoices,
}: {
  projectId: string
  isStaff: boolean
  linkedCustomer: { id: string; name: string } | null
  invoices: Invoice[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [linkOpen, setLinkOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function handleSync() {
    setMessage(null)
    startTransition(async () => {
      const res = await syncProjectInvoices({ project_id: projectId })
      setMessage(
        res.ok
          ? `Synced ${res.synced} invoice${res.synced === 1 ? "" : "s"} from QuickBooks.`
          : res.error
      )
      router.refresh()
    })
  }

  // Voided/deleted rows are staff-visible history, not receivables — keep
  // them out of the money math.
  const live = invoices.filter((i) => i.status === "open" || i.status === "paid")
  const totalBilled = live.reduce((s, i) => s + Number(i.total), 0)
  const balanceDue = live.reduce((s, i) => s + Number(i.balance), 0)
  const totalPaid = totalBilled - balanceDue

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Invoices</h2>
          <p className="text-sm text-muted mt-0.5">
            {isStaff
              ? "Created and collected in QuickBooks — this tab mirrors them into the portal."
              : "Pay securely online — the payment page is hosted by QuickBooks (Intuit)."}
          </p>
        </div>
        {isStaff && (
          <div className="flex items-center gap-2 flex-wrap">
            {linkedCustomer && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted">
                <Link2 className="h-3.5 w-3.5" />
                {linkedCustomer.name}
              </span>
            )}
            {linkedCustomer && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSync}
                disabled={pending}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
                Sync now
              </Button>
            )}
            <Button
              variant={linkedCustomer ? "outline" : "primary"}
              size="sm"
              onClick={() => setLinkOpen(true)}
            >
              {linkedCustomer ? "Change customer" : "Link QuickBooks customer"}
            </Button>
          </div>
        )}
      </div>

      {message && (
        <div className="mt-4 rounded-md border border-border-strong bg-surface px-4 py-2.5 text-sm">
          {message}
        </div>
      )}

      {live.length > 0 && (
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatTile label="Total billed" value={formatCurrency(totalBilled)} />
          <StatTile label="Paid" value={formatCurrency(totalPaid)} />
          <StatTile
            label="Balance due"
            value={formatCurrency(balanceDue)}
            emphasize={balanceDue > 0}
          />
        </div>
      )}

      <div className="mt-5">
        {invoices.length === 0 ? (
          isStaff && !linkedCustomer ? (
            <EmptyState
              icon={<ReceiptText className="h-8 w-8" />}
              title="No QuickBooks customer linked"
              description="Link this job to its QuickBooks customer to pull invoices into the portal."
              action={
                <Button size="sm" onClick={() => setLinkOpen(true)}>
                  Link QuickBooks customer
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<ReceiptText className="h-8 w-8" />}
              title="No invoices yet"
              description={
                isStaff
                  ? "Invoices created in QuickBooks for the linked customer will appear here automatically."
                  : "When an invoice is ready it will appear here."
              }
            />
          )
        ) : (
          <div className="rounded-lg border border-border bg-surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">Invoice #</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                  <th className="px-4 py-2.5 font-medium text-right">Balance</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <InvoiceRow key={inv.id} invoice={inv} isStaff={isStaff} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!isStaff && invoices.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          &ldquo;View &amp; pay&rdquo; opens your invoice on QuickBooks&rsquo; secure
          payment page. A receipt is emailed to you automatically after payment.
        </p>
      )}

      {isStaff && (
        <LinkCustomerDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          projectId={projectId}
          linkedCustomer={linkedCustomer}
        />
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  emphasize,
}: {
  label: string
  value: string
  emphasize?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tracking-tight ${
          emphasize ? "text-brand-700" : ""
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function InvoiceRow({ invoice, isStaff }: { invoice: Invoice; isStaff: boolean }) {
  const overdue =
    invoice.status === "open" &&
    !!invoice.due_date &&
    invoice.due_date < todayISO()

  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3 font-medium">
        {invoice.doc_number ? `#${invoice.doc_number}` : "—"}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">{formatDate(invoice.txn_date)}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatDate(invoice.due_date)}</td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {formatCurrency(Number(invoice.total))}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {formatCurrency(Number(invoice.balance))}
      </td>
      <td className="px-4 py-3">
        {invoice.status === "paid" ? (
          <Badge tone="success">Paid</Badge>
        ) : invoice.status === "voided" ? (
          <Badge tone="muted">Voided</Badge>
        ) : invoice.status === "deleted" ? (
          <Badge tone="muted">Removed in QuickBooks</Badge>
        ) : overdue ? (
          <Badge tone="danger">Overdue</Badge>
        ) : (
          <Badge tone="info">Open</Badge>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {invoice.status === "open" && invoice.invoice_link ? (
          <a
            href={invoice.invoice_link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline whitespace-nowrap"
          >
            View &amp; pay
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : invoice.status === "open" && isStaff ? (
          // No hosted link usually means online payments aren't enabled on
          // the QBO company — flag it to staff instead of hiding the gap.
          <span className="text-xs text-muted whitespace-nowrap">No pay link</span>
        ) : null}
      </td>
    </tr>
  )
}

function LinkCustomerDialog({
  open,
  onOpenChange,
  projectId,
  linkedCustomer,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  linkedCustomer: { id: string; name: string } | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<QboCustomerHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleSearch() {
    setError(null)
    startTransition(async () => {
      const res = await searchQboCustomers(query)
      if (res.ok) setResults(res.customers)
      else setError(res.error)
    })
  }

  function handleLink(customer: QboCustomerHit) {
    setError(null)
    startTransition(async () => {
      const res = await linkProjectQboCustomer({
        project_id: projectId,
        customer_id: customer.id,
        customer_name: customer.name,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      onOpenChange(false)
      setResults(null)
      setQuery("")
      router.refresh()
    })
  }

  function handleUnlink() {
    if (
      !confirm(
        "Unlink this QuickBooks customer? Cached invoices for this job will be removed from the portal."
      )
    ) {
      return
    }
    startTransition(async () => {
      const res = await unlinkProjectQboCustomer({ project_id: projectId })
      if (!res.ok) {
        setError(res.error ?? "Unlink failed.")
        return
      }
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <div>
            <DialogTitle>Link QuickBooks customer</DialogTitle>
            <DialogDescription>
              Invoices for the linked customer sync into this job&rsquo;s portal.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {linkedCustomer && (
            <p className="mb-3 text-sm text-muted">
              Currently linked to{" "}
              <span className="text-foreground font-medium">{linkedCustomer.name}</span>
            </p>
          )}
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleSearch()
                }
              }}
              placeholder="Search customers by name…"
            />
            <Button
              variant="secondary"
              onClick={handleSearch}
              disabled={pending || query.trim().length < 2}
            >
              <Search className="h-4 w-4" />
              Search
            </Button>
          </div>
          {error && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {results && (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {results.length === 0 && (
                <li className="px-3 py-2.5 text-sm text-muted">No customers found.</li>
              )}
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => handleLink(c)}
                    disabled={pending}
                    className="w-full px-3 py-2.5 text-left text-sm hover:bg-background disabled:opacity-50 cursor-pointer"
                  >
                    {c.name}
                    <span className="ml-2 text-xs text-muted">#{c.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            Linking runs a full sync of that customer&rsquo;s invoices; new activity
            then arrives automatically via the QuickBooks webhook.
          </p>
        </DialogBody>
        {linkedCustomer && (
          <DialogFooter>
            <Button variant="danger" size="sm" onClick={handleUnlink} disabled={pending}>
              Unlink customer
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
