import { requireStaff } from "@/lib/auth"
import { qboConfigured } from "@/lib/quickbooks/config"
import { getQboStatus } from "@/lib/quickbooks/storage"
import { getQboPushDefaults } from "@/app/actions/quickbooks"
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
  const status = await getQboStatus()
  // Only fetch push defaults when connected (getQboPushDefaults is cheap, but
  // keep the shape tidy).
  const [params, pushDefaults] = await Promise.all([
    searchParams,
    status ? getQboPushDefaults() : Promise.resolve(null),
  ])

  return (
    <QuickBooksSettingsClient
      configured={qboConfigured()}
      status={status}
      pushDefaults={pushDefaults}
      justConnected={params.connected === "1"}
      errorReason={params.error ?? null}
    />
  )
}
