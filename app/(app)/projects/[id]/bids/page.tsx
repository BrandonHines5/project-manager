import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getSignedUrlsForBids } from "@/app/actions/bids"
import { BidsClient } from "./bids-client"
import type { BidsData } from "./bids-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Bid Requests — Hines Homes" }

export default async function BidsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Bids are staff-only (subs interact via their public token links), so
  // gate the whole tab like Onsite does.
  await requireStaff()
  const { id: projectId } = await params
  const supabase = await createSupabaseServerClient()

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: packages },
    { data: lineItems },
    { data: attachments },
    { data: recipients },
    { data: quotes },
    { data: comments },
    { data: companies },
    { data: companyTrades },
    { data: costCodes },
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
    // Sub/vendor companies for the invite picker.
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .in("type", ["sub", "vendor"])
      .order("name", { ascending: true }),
    supabase.from("company_trades").select("company_id, trade"),
    supabase
      .from("cost_codes")
      .select("id, code, name, position, is_active")
      .eq("is_active", true)
      .order("position", { ascending: true }),
  ])

  // Drop the embedded joins that only exist for project filtering — same
  // pattern as the decisions page.
  const strip = <T extends { bid_packages?: unknown; bid_recipients?: unknown }>(
    rows: T[] | null
  ) =>
    (rows ?? []).map((r) => {
      const { bid_packages: _p, bid_recipients: _r, ...rest } = r
      void _p
      void _r
      return rest
    })

  const cleanedAttachments = strip(attachments) as BidsData["attachments"]
  const signedUrls = await getSignedUrlsForBids(
    cleanedAttachments.map((a) => a.storage_path)
  )

  // Flatten the joined company name onto each recipient row.
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

  const data: BidsData = {
    project_id: projectId,
    packages: packages ?? [],
    line_items: strip(lineItems) as BidsData["line_items"],
    attachments: cleanedAttachments,
    recipients: cleanedRecipients,
    quotes: strip(quotes) as BidsData["quotes"],
    comments: strip(comments) as BidsData["comments"],
    companies: companies ?? [],
    company_trades: companyTrades ?? [],
    cost_codes: costCodes ?? [],
    signed_urls: signedUrls,
  }

  return <BidsClient data={data} />
}
