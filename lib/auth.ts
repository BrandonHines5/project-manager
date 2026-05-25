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
  if (process.env.NODE_ENV === "production") {
    // Temporary debug — remove once auth is verified working
    console.log("[auth] getSessionProfile:", {
      hasUser: !!user,
      userId: user?.id,
      userErr: userErr?.message,
    })
  }
  if (!user) return null

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle()
  if (process.env.NODE_ENV === "production") {
    console.log("[auth] profile lookup:", {
      hasProfile: !!profile,
      profileErr: profileErr?.message,
    })
  }

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
