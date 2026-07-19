import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { getActiveOrgId } from "@/lib/org"
import { listQuoPhoneNumbers } from "@/lib/quo"
import { TeamClient } from "./team-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Team — BuildFox" }

export default async function TeamPage() {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const orgId = await getActiveOrgId(supabase, me.id)
  const [{ data: profiles }, { data: companies }, quoNumbers] =
    await Promise.all([
      supabase.from("profiles").select("*").order("full_name"),
      supabase
        .from("companies")
        .select("id, name, type, trade_category")
        .order("name"),
      // Empty when the org has no Quo key — the picker then just offers the
      // shared-number default.
      listQuoPhoneNumbers(orgId),
    ])
  return (
    <TeamClient
      profiles={(profiles ?? []) as Tables<"profiles">[]}
      companies={
        (companies ?? []) as Pick<
          Tables<"companies">,
          "id" | "name" | "type" | "trade_category"
        >[]
      }
      quoNumbers={quoNumbers}
      currentUserId={me.id}
    />
  )
}
