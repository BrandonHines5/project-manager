import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getSignedUrlsForPOs } from "@/app/actions/purchase-orders"
import { PurchaseOrdersClient } from "./purchase-orders-client"
import type { PurchaseOrdersData } from "./purchase-orders-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Purchase Orders — Hines Homes" }

export default async function PurchaseOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ open?: string }>
}) {
  // POs are staff-only in-app (subs approve via their public token links).
  await requireStaff()
  const { id: projectId } = await params
  const { open } = await searchParams
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: pos, error: posError },
    { data: lineItems, error: lineItemsError },
    { data: attachments, error: attachmentsError },
    { data: comments, error: commentsError },
    { data: companies, error: companiesError },
    { data: costCodes, error: costCodesError },
  ] = await Promise.all([
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
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .in("type", ["sub", "vendor"])
      .order("name", { ascending: true }),
    supabase
      .from("cost_codes")
      .select("id, code, name, position, is_active")
      .eq("is_active", true)
      .order("position", { ascending: true }),
  ])

  const queryError =
    posError ??
    lineItemsError ??
    attachmentsError ??
    commentsError ??
    companiesError ??
    costCodesError
  if (queryError) throw new Error(queryError.message)

  const strip = <T extends { purchase_orders?: unknown }>(rows: T[] | null) =>
    (rows ?? []).map((r) => {
      const { purchase_orders: _drop, ...rest } = r
      void _drop
      return rest
    })

  // Flatten the joined vendor name onto each PO row.
  const cleanedPos: PurchaseOrdersData["pos"] = (pos ?? []).map((p) => {
    const { companies: co, ...rest } = p as unknown as
      Tables<"purchase_orders"> & { companies: { name: string } | null }
    return { ...rest, company_name: co?.name ?? "Unknown company" }
  })

  // Resolve "From BID-N: title" chips for POs created by awarding a bid.
  // Fetched separately rather than a deep 3-level embed.
  const sourceIds = cleanedPos
    .map((p) => p.source_bid_recipient_id)
    .filter((x): x is string => !!x)
  let sourceBids: PurchaseOrdersData["source_bids"] = {}
  if (sourceIds.length) {
    const { data: sources } = await supabase
      .from("bid_recipients")
      .select("id, bid_packages:bid_package_id(number, title)")
      .in("id", sourceIds)
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

  const cleanedAttachments = strip(attachments) as PurchaseOrdersData["attachments"]
  const signedUrls = await getSignedUrlsForPOs(
    cleanedAttachments.map((a) => a.storage_path)
  )

  const data: PurchaseOrdersData = {
    project_id: projectId,
    // Auto-open a drawer via ?open=<po_id> (e.g. the "Open PO" link after
    // awarding a bid). Ignore ids that aren't in this project.
    open_po_id: open && cleanedPos.some((p) => p.id === open) ? open : null,
    pos: cleanedPos,
    line_items: strip(lineItems) as PurchaseOrdersData["line_items"],
    attachments: cleanedAttachments,
    comments: strip(comments) as PurchaseOrdersData["comments"],
    companies: companies ?? [],
    cost_codes: costCodes ?? [],
    source_bids: sourceBids,
    signed_urls: signedUrls,
  }

  return <PurchaseOrdersClient data={data} />
}
