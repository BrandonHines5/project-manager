import { requireStaff } from "@/lib/auth"
import { appUrl } from "@/lib/email"
import { qboConfigured } from "@/lib/quickbooks/config"
import { getQboStatus } from "@/lib/quickbooks/storage"
import { getQboPushDefaults } from "@/app/actions/quickbooks"
import { getInvoicePaymentRecipientConfig } from "@/app/actions/invoices"
import { QuickBooksSettingsClient } from "./quickbooks-client"

export const metadata = { title: "QuickBooks — BuildFox" }
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
  const [params, pushDefaults, paymentRecipients] = await Promise.all([
    searchParams,
    status ? getQboPushDefaults() : Promise.resolve(null),
    status ? getInvoicePaymentRecipientConfig() : Promise.resolve(null),
  ])

  return (
    <QuickBooksSettingsClient
      // Remount on company change so local push-defaults state is re-derived
      // from the new connection (avoids carrying a prior company's IDs).
      key={status?.realm_id ?? "disconnected"}
      configured={qboConfigured()}
      status={status}
      pushDefaults={pushDefaults}
      justConnected={params.connected === "1"}
      errorReason={params.error ?? null}
      webhookUrl={appUrl("/api/qbo/webhook")}
      webhookConfigured={!!process.env.QBO_WEBHOOK_VERIFIER_TOKEN}
      paymentRecipients={paymentRecipients}
    />
  )
}
