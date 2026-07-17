import { redirect } from "next/navigation"

/**
 * Legacy route — bids now live on the unified /purchasing page. Deep links
 * (?open=<package_id>[&recipient=<recipient_id>] from the Communications
 * feed / bell) are preserved through the redirect.
 */
export default async function BidsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ open?: string; recipient?: string }>
}) {
  const { id } = await params
  const { open, recipient } = await searchParams
  const qs = new URLSearchParams({ tab: "bids" })
  if (open) qs.set("open", open)
  if (recipient) qs.set("recipient", recipient)
  redirect(`/projects/${id}/purchasing?${qs.toString()}`)
}
