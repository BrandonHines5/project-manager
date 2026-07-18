import { requireStaff } from "@/lib/auth"
import { getDelayReasons } from "@/app/actions/settings"
import { DelayReasonsSettingsClient } from "./delay-reasons-settings-client"

export const metadata = { title: "Delay reasons — BuildFox" }
export const dynamic = "force-dynamic"

export default async function DelayReasonsSettingsPage() {
  // Staff-only config; requireStaff redirects clients/trades to /projects.
  await requireStaff()
  const reasons = await getDelayReasons()
  return <DelayReasonsSettingsClient initialReasons={reasons} />
}
