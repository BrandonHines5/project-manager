import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { CompaniesClient } from "./companies-client"
import type { Tables } from "@/lib/db/types"

export const metadata = { title: "Companies — Hines Homes" }

export default async function CompaniesPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: companies } = await supabase
    .from("companies")
    .select("*")
    .order("name")
  return <CompaniesClient companies={(companies ?? []) as Tables<"companies">[]} />
}
