import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { CompaniesClient } from "./companies-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Companies — Hines Homes" }

export default async function CompaniesPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  // Fetch companies + the full junction in parallel. The junction is small
  // (~companies × ~few trades each) so loading it all upfront is fine and
  // saves a per-row fetch when the dialog opens. The TradeChipsEditor also
  // needs the global pool for its suggestions row, served from the same data.
  const [{ data: companies }, { data: trades }] = await Promise.all([
    supabase.from("companies").select("*").order("name"),
    supabase
      .from("company_trades")
      .select("company_id, trade"),
  ])
  const tradesByCompany = new Map<string, string[]>()
  const tradePool = new Set<string>()
  for (const t of trades ?? []) {
    const list = tradesByCompany.get(t.company_id) ?? []
    list.push(t.trade)
    tradesByCompany.set(t.company_id, list)
    tradePool.add(t.trade)
  }
  return (
    <CompaniesClient
      companies={(companies ?? []) as Tables<"companies">[]}
      tradesByCompany={Object.fromEntries(
        Array.from(tradesByCompany.entries()).map(([k, v]) => [k, v.sort()])
      )}
      allTrades={Array.from(tradePool).sort()}
    />
  )
}
