import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getSignedUrlsForBids } from "@/app/actions/bids"
import { getSignedUrlsForPOs } from "@/app/actions/purchase-orders"
import { listPurchasingTemplates } from "@/app/actions/purchasing-templates"
import type { BidsData } from "../bids/bids-client"
import type { PurchaseOrdersData } from "../purchase-orders/purchase-orders-client"
import { PurchasingClient, type PurchasingTab } from "./purchasing-client"
import type { Tables } from "@/lib/db/types"
import type { PurchasingFileOption } from "@/components/purchasing/files-picker"

export const metadata = { title: "Bids & POs — Hines Homes" }

/**
 * Unified purchasing page: Bid requests and Purchase orders live behind one
 * tab with a toggle (the legacy /bids and /purchase-orders routes redirect
 * here, preserving ?open= deep links). Staff-only — subs interact via their
 * public token links.
 */
export default async function PurchasingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; open?: string; recipient?: string }>
}) {
  await requireStaff()
  const { id: projectId } = await params
  const { tab, open, recipient } = await searchParams
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    // Bid tables
    { data: packages },
    { data: bidLineItems },
    { data: bidAttachments },
    { data: recipients },
    { data: quotes },
    { data: bidComments },
    { data: companyTrades },
    // PO tables
    { data: pos, error: posError },
    { data: poLineItems, error: poLineItemsError },
    { data: poAttachments, error: poAttachmentsError },
    { data: poComments, error: poCommentsError },
    // Shared
    { data: companies, error: companiesError },
    { data: costCodes, error: costCodesError },
    { data: projects, error: projectsError },
    { data: projectFiles, error: projectFilesError },
  ] = await Promise.all([
    supabase
      .from("bid_packages")
      .select("*")
      .eq("project_id", projectId)
      .order("number", { ascending: false }),
    supabase
      .from("bid_package_line_items")
      .select("*, bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("bid_package_attachments")
      .select("*, bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("bid_recipients")
      .select("*, companies:company_id(name), bid_packages!inner(project_id)")
      .eq("bid_packages.project_id", projectId)
      .order("created_at", { ascending: true }),
    supabase
      .from("bid_line_item_quotes")
      .select("*, bid_recipients!inner(bid_packages!inner(project_id))")
      .eq("bid_recipients.bid_packages.project_id", projectId),
    supabase
      .from("bid_comments")
      .select("*, bid_recipients!inner(bid_packages!inner(project_id))")
      .eq("bid_recipients.bid_packages.project_id", projectId)
      .order("created_at", { ascending: true }),
    supabase.from("company_trades").select("company_id, trade"),
    supabase
      .from("purchase_orders")
      .select("*, companies:company_id(name)")
      .eq("project_id", projectId)
      .order("number", { ascending: false }),
    supabase
      .from("po_line_items")
      .select("*, purchase_orders!inner(project_id)")
      .eq("purchase_orders.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("po_attachments")
      .select("*, purchase_orders!inner(project_id)")
      .eq("purchase_orders.project_id", projectId)
      .order("position", { ascending: true }),
    supabase
      .from("po_comments")
      .select("*, purchase_orders!inner(project_id)")
      .eq("purchase_orders.project_id", projectId)
      .order("created_at", { ascending: true }),
    // Sub/vendor companies — the invite picker and the PO vendor select.
    supabase
      .from("companies")
      .select("id, name, type, trade_category, status")
      .in("type", ["sub", "vendor"])
      .order("name", { ascending: true }),
    supabase
      .from("cost_codes")
      .select("id, code, name, position, is_active")
      .eq("is_active", true)
      .order("position", { ascending: true }),
    // Projects the caller can see — destinations for "copy to another job".
    supabase
      .from("projects")
      .select("id, name, project_number")
      .order("project_number", { ascending: true }),
    // Current Files-tab documents — the drawers' "Link from Files" picker.
    supabase
      .from("project_files")
      .select(
        "id, title, category, file_name, file_type, file_size, storage_path"
      )
      .eq("project_id", projectId)
      .eq("is_current", true)
      .is("archived_at", null)
      .order("title", { ascending: true }),
  ])

  const queryError =
    posError ??
    poLineItemsError ??
    poAttachmentsError ??
    poCommentsError ??
    companiesError ??
    costCodesError ??
    projectsError ??
    projectFilesError
  if (queryError) throw new Error(queryError.message)

  const templates = await listPurchasingTemplates()
  const files: PurchasingFileOption[] = projectFiles ?? []

  // ---- Bid data (same shaping as the legacy bids page) ----
  const stripBid = <
    T extends { bid_packages?: unknown; bid_recipients?: unknown },
  >(
    rows: T[] | null
  ) =>
    (rows ?? []).map((r) => {
      const { bid_packages: _p, bid_recipients: _r, ...rest } = r
      void _p
      void _r
      return rest
    })

  const cleanedBidAttachments = stripBid(
    bidAttachments
  ) as BidsData["attachments"]
  const cleanedRecipients: BidsData["recipients"] = (recipients ?? []).map(
    (r) => {
      const { companies: co, bid_packages: _drop, ...rest } = r as unknown as
        Tables<"bid_recipients"> & {
          companies: { name: string } | null
          bid_packages: unknown
        }
      void _drop
      return { ...rest, company_name: co?.name ?? "Unknown company" }
    }
  )

  const cleanedPackages = packages ?? []

  // ---- PO data (same shaping as the legacy purchase-orders page) ----
  const stripPo = <T extends { purchase_orders?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { purchase_orders: _drop, ...rest } = r
      void _drop
      return rest
    })

  const cleanedPos: PurchaseOrdersData["pos"] = (pos ?? []).map((p) => {
    const { companies: co, ...rest } = p as unknown as
      Tables<"purchase_orders"> & { companies: { name: string } | null }
    return { ...rest, company_name: co?.name ?? "Unknown company" }
  })

  // "From BID-N" chips — separate query, not a deep embed.
  const sourceBidIds = cleanedPos
    .map((p) => p.source_bid_recipient_id)
    .filter((x): x is string => !!x)
  let sourceBids: PurchaseOrdersData["source_bids"] = {}
  if (sourceBidIds.length) {
    const { data: sources } = await supabase
      .from("bid_recipients")
      .select("id, bid_packages:bid_package_id(number, title)")
      .in("id", sourceBidIds)
    sourceBids = Object.fromEntries(
      (sources ?? []).flatMap((s) => {
        const pkg = (
          s as unknown as {
            id: string
            bid_packages: { number: number; title: string } | null
          }
        ).bid_packages
        return pkg ? [[s.id, { number: pkg.number, title: pkg.title }]] : []
      })
    )
  }

  // "From Selection/CO #N" chips — separate query too (purchase_orders ↔
  // decisions must never rely on embeds, per the PGRST201 note).
  const sourceDecisionIds = cleanedPos
    .map((p) => p.source_decision_id)
    .filter((x): x is string => !!x)
  let sourceDecisions: PurchaseOrdersData["source_decisions"] = {}
  if (sourceDecisionIds.length) {
    const { data: decisions } = await supabase
      .from("decisions")
      .select("id, kind, number, title")
      .in("id", sourceDecisionIds)
    sourceDecisions = Object.fromEntries(
      (decisions ?? []).map((d) => [
        d.id,
        { kind: d.kind, number: d.number, title: d.title },
      ])
    )
  }

  const cleanedPoAttachments = stripPo(
    poAttachments
  ) as PurchaseOrdersData["attachments"]

  const [bidSignedUrls, poSignedUrls] = await Promise.all([
    getSignedUrlsForBids(cleanedBidAttachments.map((a) => a.storage_path)),
    getSignedUrlsForPOs(cleanedPoAttachments.map((a) => a.storage_path)),
  ])

  // ---- Deep link resolution: ?open= can be a bid package or a PO. An
  // explicit ?tab= wins for the toggle; the open id decides otherwise.
  const openBidId =
    open && cleanedPackages.some((p) => p.id === open) ? open : null
  const openPoId = open && cleanedPos.some((p) => p.id === open) ? open : null
  const initialTab: PurchasingTab =
    tab === "pos" || (tab !== "bids" && openPoId) ? "pos" : "bids"

  const bidsData: BidsData = {
    project_id: projectId,
    open_package_id: initialTab === "bids" ? openBidId : null,
    open_recipient_id:
      initialTab === "bids" &&
      openBidId &&
      recipient &&
      cleanedRecipients.some((r) => r.id === recipient)
        ? recipient
        : null,
    packages: cleanedPackages,
    line_items: stripBid(bidLineItems) as BidsData["line_items"],
    attachments: cleanedBidAttachments,
    recipients: cleanedRecipients,
    quotes: stripBid(quotes) as BidsData["quotes"],
    comments: stripBid(bidComments) as BidsData["comments"],
    companies: companies ?? [],
    company_trades: companyTrades ?? [],
    cost_codes: costCodes ?? [],
    projects: projects ?? [],
    files,
    signed_urls: bidSignedUrls,
  }

  const posData: PurchaseOrdersData = {
    project_id: projectId,
    open_po_id: initialTab === "pos" ? openPoId : null,
    pos: cleanedPos,
    line_items: stripPo(poLineItems) as PurchaseOrdersData["line_items"],
    attachments: cleanedPoAttachments,
    comments: stripPo(poComments) as PurchaseOrdersData["comments"],
    companies: companies ?? [],
    cost_codes: costCodes ?? [],
    projects: projects ?? [],
    source_bids: sourceBids,
    source_decisions: sourceDecisions,
    files,
    signed_urls: poSignedUrls,
  }

  return (
    <PurchasingClient
      bids={bidsData}
      pos={posData}
      templates={templates}
      initialTab={initialTab}
    />
  )
}
