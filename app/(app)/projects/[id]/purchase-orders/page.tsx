import { redirect } from "next/navigation"

/**
 * Legacy route — POs now live on the unified /purchasing page. Deep links
 * (?open=<po_id> from the award flow, bell and Communications feed) are
 * preserved through the redirect.
 */
export default async function PurchaseOrdersRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ open?: string }>
}) {
  const { id } = await params
  const { open } = await searchParams
  const qs = new URLSearchParams({ tab: "pos" })
  if (open) qs.set("open", open)
  redirect(`/projects/${id}/purchasing?${qs.toString()}`)
}
