"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"

/**
 * Switch the caller's active organization (B5). Validates the target against
 * their OWN organization_members rows — a non-membership is rejected, so
 * profiles.active_org_id can only ever point somewhere getActiveOrgId would
 * honor anyway. Self-update rides profiles_self_update RLS.
 */
export async function setActiveOrg(
  orgId: string
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  const parsed = z.string().uuid().safeParse(orgId)
  if (!parsed.success) return { ok: false, error: "Invalid organization." }
  const supabase = await createSupabaseServerClient()

  const { data: membership, error: memErr } = await supabase
    .from("organization_members")
    .select("org_id")
    .eq("profile_id", profile.id)
    .eq("org_id", parsed.data)
    .maybeSingle()
  if (memErr) return { ok: false, error: memErr.message }
  if (!membership) {
    return { ok: false, error: "You aren't a member of that organization." }
  }

  const { error } = await supabase
    .from("profiles")
    .update({ active_org_id: parsed.data })
    .eq("id", profile.id)
  if (error) return { ok: false, error: error.message }

  // Every layout and page derives branding/data from the active org.
  revalidatePath("/", "layout")
  return { ok: true }
}
