import { requireStaff } from "@/lib/auth"
import { qboConfigured } from "@/lib/quickbooks/config"
import { getQboStatus } from "@/lib/quickbooks/storage"
import { QuickBooksSettingsClient } from "./quickbooks-client"

export const metadata = { title: "QuickBooks — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function QuickBooksSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  // Staff-only; requireStaff redirects clients/trades to /projects.
  await requireStaff()
  const [params, status] = await Promise.all([searchParams, getQboStatus()])

  return (
    <QuickBooksSettingsClient
      configured={qboConfigured()}
      status={status}
      justConnected={params.connected === "1"}
      errorReason={params.error ?? null}
    />
  )
}
