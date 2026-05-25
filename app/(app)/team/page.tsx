import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { TeamClient } from "./team-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Team — Hines Homes" }

export default async function TeamPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const [{ data: profiles }, { data: companies }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .order("full_name"),
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .order("name"),
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
    />
  )
}
