import { redirect } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import type { Tables, Enums } from "@/lib/db/types"

export type SessionProfile = Tables<"profiles">
export type UserRole = Enums<"user_role">

export async function getSessionProfile(): Promise<SessionProfile | null> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  console.log(
    `[auth] user=${user?.id?.slice(0, 8) ?? "NULL"} err=${userErr?.message ?? "ok"}`
  )
  if (!user) return null

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle()
  console.log(
    `[auth] profile=${profile?.id?.slice(0, 8) ?? "NULL"} err=${profileErr?.message ?? "ok"}`
  )

  return profile ?? null
}

export async function requireSession(): Promise<SessionProfile> {
  const profile = await getSessionProfile()
  if (!profile) redirect("/login")
  return profile
}

export async function requireStaff(): Promise<SessionProfile> {
  const profile = await requireSession()
  if (profile.role !== "staff") redirect("/projects")
  return profile
}
