"use client"

import { useState } from "react"
import { Plus, Gavel, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BidsClient, type BidsData } from "../bids/bids-client"
import {
  PurchaseOrdersClient,
  type PurchaseOrdersData,
} from "../purchase-orders/purchase-orders-client"
import { NewPurchasingDialog } from "@/components/purchasing/new-purchasing-dialog"
import type { PurchasingTemplateRow } from "@/app/actions/purchasing-templates"

export type PurchasingTab = "bids" | "pos"

/**
 * One page for Bid requests + Purchase orders: a segmented toggle hosts the
 * two existing list clients (both stay mounted so drawer/list state survives
 * flipping), and a single "New…" button opens the shared create form with
 * its bid/PO toggle. Deep links use ?tab=bids|pos&open=<id> — the legacy
 * /bids and /purchase-orders routes redirect here.
 */
export function PurchasingClient({
  bids,
  pos,
  templates,
  initialTab,
}: {
  bids: BidsData
  pos: PurchaseOrdersData
  templates: PurchasingTemplateRow[]
  initialTab: PurchasingTab
}) {
  const [tab, setTab] = useState<PurchasingTab>(initialTab)
  const [newOpen, setNewOpen] = useState(false)

  // Same-route deep links (the create dialog pushes ?tab=…&open=… while this
  // tree stays mounted) must still flip the toggle. Render-time derived-state
  // sync — same sanctioned pattern as SectionTabs' lastProjectId.
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab)
    setTab(initialTab)
  }

  function switchTab(next: PurchasingTab) {
    setTab(next)
    // Keep the URL shareable without a server round-trip.
    window.history.replaceState(
      null,
      "",
      `/projects/${bids.project_id}/purchasing?tab=${next}`
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div
          className="inline-flex rounded-md border border-border-strong overflow-hidden"
          role="tablist"
          aria-label="Bids or purchase orders"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bids"}
            onClick={() => switchTab("bids")}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors",
              tab === "bids"
                ? "bg-brand-500 text-white"
                : "bg-surface text-muted hover:text-foreground"
            )}
          >
            <Gavel className="h-3.5 w-3.5" /> Bid requests
            <span className="text-xs opacity-80">({bids.packages.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pos"}
            onClick={() => switchTab("pos")}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors border-l border-border-strong",
              tab === "pos"
                ? "bg-brand-500 text-white"
                : "bg-surface text-muted hover:text-foreground"
            )}
          >
            <FileText className="h-3.5 w-3.5" /> Purchase orders
            <span className="text-xs opacity-80">({pos.pos.length})</span>
          </button>
        </div>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New…
        </Button>
      </div>

      {/* Both stay mounted — flipping tabs must not reset list/drawer state
          or re-trigger the ?open= auto-open. Drawers render in portals, so
          hiding the container never hides an open drawer. */}
      <div className={tab === "bids" ? "" : "hidden"}>
        <BidsClient data={bids} embedded />
      </div>
      <div className={tab === "pos" ? "" : "hidden"}>
        <PurchaseOrdersClient data={pos} embedded />
      </div>

      {newOpen && (
        <NewPurchasingDialog
          open={true}
          onClose={() => setNewOpen(false)}
          projectId={bids.project_id}
          companies={pos.companies}
          costCodes={pos.cost_codes}
          templates={templates}
        />
      )}
    </div>
  )
}
