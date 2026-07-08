"use client"

import { useState } from "react"
import { Plus, FileText, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardBody } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { Tables, Enums } from "@/lib/db/types"
import { PoDrawer } from "@/components/purchase-orders/po-drawer"

export type PurchaseOrdersData = {
  project_id: string
  // PO to auto-open on load (from ?open=<po_id>), already validated server-side.
  open_po_id: string | null
  pos: (Tables<"purchase_orders"> & { company_name: string })[]
  line_items: Tables<"po_line_items">[]
  attachments: Tables<"po_attachments">[]
  comments: Tables<"po_comments">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  cost_codes: Pick<Tables<"cost_codes">, "id" | "code" | "name" | "position" | "is_active">[]
  // Projects the caller can see — destinations for "Copy to job…".
  projects: Pick<Tables<"projects">, "id" | "name" | "project_number">[]
  // source_bid_recipient_id -> the bid package it was awarded from.
  source_bids: Record<string, { number: number; title: string }>
  signed_urls: Record<string, string>
}

export function PurchaseOrdersClient({ data }: { data: PurchaseOrdersData }) {
  const [drawerState, setDrawerState] = useState<
    { mode: "create" } | { mode: "edit"; poId: string } | null
  >(() => (data.open_po_id ? { mode: "edit", poId: data.open_po_id } : null))

  const editingPo =
    drawerState?.mode === "edit"
      ? data.pos.find((p) => p.id === drawerState.poId)
      : undefined

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-lg font-semibold">Purchase orders</h2>
        <Button size="sm" onClick={() => setDrawerState({ mode: "create" })}>
          <Plus className="h-3.5 w-3.5" /> New PO
        </Button>
      </div>

      {data.pos.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title="No purchase orders yet"
          description="Issue a cost-coded PO to a sub or vendor. They approve with a typed signature through a private link — no login needed. Approved POs roll into committed costs on Pricing."
          action={
            <Button onClick={() => setDrawerState({ mode: "create" })}>
              <Plus className="h-4 w-4" /> New PO
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {data.pos.map((po) => {
            const total = poTotal(po, data)
            return (
              <Card
                key={po.id}
                role="button"
                tabIndex={0}
                className="hover:border-brand-500/50 transition-colors cursor-pointer"
                onClick={() => setDrawerState({ mode: "edit", poId: po.id })}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setDrawerState({ mode: "edit", poId: po.id })
                  }
                }}
              >
                <CardBody className="py-3.5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs text-muted">
                      PO-{po.number}
                      {po.custom_number ? ` · ${po.custom_number}` : ""}
                    </span>
                    <span className="font-medium">{po.title}</span>
                    <PoStatusBadge status={po.status} />
                    {po.work_complete && (
                      <Badge tone="success">
                        <CheckCircle2 className="h-3 w-3" /> Work complete
                      </Badge>
                    )}
                    <span className="ml-auto font-mono tabular-nums text-sm">
                      {total != null ? formatCurrency(total) : "—"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-4 text-xs text-muted flex-wrap">
                    <span>{po.company_name}</span>
                    {po.approval_deadline && (
                      <span>
                        Approval due {formatDate(po.approval_deadline)}
                      </span>
                    )}
                    {po.source_bid_recipient_id &&
                      data.source_bids[po.source_bid_recipient_id] && (
                        <span>
                          From BID-
                          {data.source_bids[po.source_bid_recipient_id].number}
                        </span>
                      )}
                  </div>
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      {drawerState && (
        <PoDrawer
          open={true}
          onClose={() => setDrawerState(null)}
          data={data}
          po={editingPo}
        />
      )}
    </div>
  )
}

export function PoStatusBadge({ status }: { status: Enums<"po_status"> }) {
  const map = {
    draft: { label: "Draft", tone: "muted" as const },
    released: { label: "Under review", tone: "warning" as const },
    approved: { label: "Approved", tone: "success" as const },
    declined: { label: "Declined", tone: "danger" as const },
    void: { label: "Void", tone: "neutral" as const },
  }
  const { label, tone } = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

/** PO total: flat_total in flat-fee mode, otherwise the line-item sum. */
export function poTotal(
  po: Tables<"purchase_orders">,
  data: PurchaseOrdersData
): number | null {
  if (po.flat_fee) return po.flat_total == null ? null : Number(po.flat_total)
  const items = data.line_items.filter((li) => li.purchase_order_id === po.id)
  if (items.length === 0) return null
  return items.reduce(
    (sum, li) => sum + Number(li.quantity) * Number(li.unit_cost),
    0
  )
}
