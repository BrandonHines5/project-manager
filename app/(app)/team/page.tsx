import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { listQuoPhoneNumbers } from "@/lib/quo"
import { TeamClient } from "./team-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Team — Hines Homes" }

export default async function TeamPage() {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const [{ data: profiles }, { data: companies }, quoNumbers] =
    await Promise.all([
      supabase.from("profiles").select("*").order("full_name"),
      supabase
        .from("companies")
        .select("id, name, type, trade_category")
        .order("name"),
      // Empty when Quo isn't wired up (QUO_API_KEY unset) — the picker then
      // just offers the shared-number default.
      listQuoPhoneNumbers(),
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
