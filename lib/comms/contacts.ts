import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import type { ComposeContact } from "@/components/comms/compose-dialog"

/**
 * The whole company directory as compose targets, shared by the global hub
 * and the per-project Communications tab so the two lists can't drift. The
 * address fields are display only — composeMessage re-resolves the
 * destination server-side from the company id.
 */
export async function buildCompanyContacts(
  supabase: SupabaseClient<Database>
): Promise<ComposeContact[]> {
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, email, phone, phone_secondary, type, trade_category")
    .order("name")
  return (companies ?? []).map((c) => ({
    id: `company:${c.id}`,
    name: c.name,
    detail: c.type === "client" ? "client" : c.trade_category || c.type,
    email: c.email,
    phone: c.phone || c.phone_secondary,
    recipient: { kind: "company" as const, company_id: c.id },
  }))
}
