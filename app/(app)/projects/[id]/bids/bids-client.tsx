"use client"

import { useState } from "react"
import { Plus, Gavel, Columns3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardBody } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { Tables, Enums } from "@/lib/db/types"
import { BidPackageDrawer } from "@/components/bids/bid-package-drawer"
import { BidComparison } from "@/components/bids/bid-comparison"

export type BidsData = {
  project_id: string
  packages: Tables<"bid_packages">[]
  line_items: Tables<"bid_package_line_items">[]
  attachments: Tables<"bid_package_attachments">[]
  recipients: (Tables<"bid_recipients"> & { company_name: string })[]
  quotes: Tables<"bid_line_item_quotes">[]
  comments: Tables<"bid_comments">[]
  // Sub/vendor companies for the invite picker.
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  company_trades: Pick<Tables<"company_trades">, "company_id" | "trade">[]
  cost_codes: Pick<Tables<"cost_codes">, "id" | "code" | "name" | "position" | "is_active">[]
  signed_urls: Record<string, string>
}

export function BidsClient({ data }: { data: BidsData }) {
  const [drawerState, setDrawerState] = useState<
    { mode: "create" } | { mode: "edit"; packageId: string } | null
  >(null)
  const [compareId, setCompareId] = useState<string | null>(null)

  const editingPackage =
    drawerState?.mode === "edit"
      ? data.packages.find((p) => p.id === drawerState.packageId)
      : undefined
  const comparePackage = compareId
    ? data.packages.find((p) => p.id === compareId)
    : undefined

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-lg font-semibold">Bid requests</h2>
        <Button size="sm" onClick={() => setDrawerState({ mode: "create" })}>
          <Plus className="h-3.5 w-3.5" /> New bid request
        </Button>
      </div>

      {data.packages.length === 0 ? (
        <EmptyState
          icon={<Gavel className="h-10 w-10" />}
          title="No bid requests yet"
          description="Define a scope, send it to multiple subs or vendors, and compare their pricing side by side. Awarding a bid can auto-create a purchase order."
          action={
            <Button onClick={() => setDrawerState({ mode: "create" })}>
              <Plus className="h-4 w-4" /> New bid request
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {data.packages.map((p) => (
            <BidPackageCard
              key={p.id}
              pkg={p}
              data={data}
              onOpen={() => setDrawerState({ mode: "edit", packageId: p.id })}
              onCompare={() => setCompareId(p.id)}
            />
          ))}
        </div>
      )}

      {drawerState && (
        <BidPackageDrawer
          open={true}
          onClose={() => setDrawerState(null)}
          data={data}
          pkg={editingPackage}
        />
      )}
      {comparePackage && (
        <BidComparison
          open={true}
          onClose={() => setCompareId(null)}
          data={data}
          pkg={comparePackage}
        />
      )}
    </div>
  )
}

function BidPackageCard({
  pkg,
  data,
  onOpen,
  onCompare,
}: {
  pkg: Tables<"bid_packages">
  data: BidsData
  onOpen: () => void
  onCompare: () => void
}) {
  const recipients = data.recipients.filter((r) => r.bid_package_id === pkg.id)
  const responded = recipients.filter(
    (r) => r.status === "submitted" || r.status === "awarded"
  )

  const totals = responded
    .map((r) => recipientBidTotal(r, pkg, data))
    .filter((t): t is number => t != null)
  const min = totals.length ? Math.min(...totals) : null
  const max = totals.length ? Math.max(...totals) : null

  return (
    <Card
      className="hover:border-brand-500/50 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      <CardBody className="py-3.5">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-xs text-muted">BID-{pkg.number}</span>
          <span className="font-medium">{pkg.title}</span>
          <BidStatusBadge status={pkg.status} />
          {pkg.flat_fee && <Badge tone="info">Flat fee</Badge>}
          <div className="ml-auto flex items-center gap-2">
            {recipients.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation()
                  onCompare()
                }}
              >
                <Columns3 className="h-3.5 w-3.5" /> Compare bids
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-4 text-xs text-muted flex-wrap">
          {pkg.due_date && <span>Due {formatDate(pkg.due_date)}</span>}
          {recipients.length > 0 ? (
            <span>
              {responded.length} of {recipients.length} submitted
            </span>
          ) : (
            <span>No recipients yet</span>
          )}
          {min != null && (
            <span className="font-mono tabular-nums text-foreground">
              {min === max
                ? formatCurrency(min)
                : `${formatCurrency(min)} – ${formatCurrency(max)}`}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

export function BidStatusBadge({
  status,
}: {
  status: Enums<"bid_package_status">
}) {
  const map = {
    draft: { label: "Draft", tone: "muted" as const },
    sent: { label: "Collecting bids", tone: "warning" as const },
    awarded: { label: "Awarded", tone: "success" as const },
    closed: { label: "Closed", tone: "neutral" as const },
  }
  const { label, tone } = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

export function RecipientStatusBadge({
  status,
}: {
  status: Enums<"bid_recipient_status">
}) {
  const map = {
    invited: { label: "Invited", tone: "muted" as const },
    submitted: { label: "Submitted", tone: "info" as const },
    declined: { label: "Declined", tone: "danger" as const },
    awarded: { label: "Awarded", tone: "success" as const },
  }
  const { label, tone } = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

/**
 * A recipient's total bid. Flat-fee packages use their flat_total; line-mode
 * packages sum unit_cost × quantity across their quotes (flat_total is a
 * denormalized copy of the same sum, but computing keeps it exact even if
 * denormalization lags).
 */
export function recipientBidTotal(
  recipient: BidsData["recipients"][number],
  pkg: Tables<"bid_packages">,
  data: BidsData
): number | null {
  if (pkg.flat_fee) {
    return recipient.flat_total == null ? null : Number(recipient.flat_total)
  }
  const items = data.line_items.filter((li) => li.bid_package_id === pkg.id)
  const quotes = data.quotes.filter((q) => q.bid_recipient_id === recipient.id)
  if (quotes.length === 0) {
    return recipient.flat_total == null ? null : Number(recipient.flat_total)
  }
  let total = 0
  for (const q of quotes) {
    const li = items.find((i) => i.id === q.line_item_id)
    if (!li) continue
    total += Number(q.unit_cost) * Number(li.quantity)
  }
  return total
}
