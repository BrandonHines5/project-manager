"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"

const Input = z.object({
  project_id: z.string().uuid(),
  muted: z.boolean(),
})

/**
 * Turn the caller's notifications for one job on or off (personal — never
 * affects anyone else). RLS (npm_owner_all) is the real gate: the row's
 * profile_id is always the session user. A mute suppresses in-app rows via
 * the notifications trigger (0121) and the direct email senders via
 * mutedProfileIdsForProject.
 */
export async function setProjectNotificationsMuted(input: {
  project_id: string
  muted: boolean
}) {
  const me = await requireSession()
  const parsed = Input.parse(input)
  const supabase = await createSupabaseServerClient()

  if (parsed.muted) {
    const { error } = await supabase.from("notification_project_mutes").upsert(
      { profile_id: me.id, project_id: parsed.project_id },
      { onConflict: "profile_id,project_id", ignoreDuplicates: true }
    )
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase
      .from("notification_project_mutes")
      .delete()
      .eq("profile_id", me.id)
      .eq("project_id", parsed.project_id)
    if (error) throw new Error(error.message)
  }

  revalidatePath(`/projects/${parsed.project_id}`, "layout")
  revalidatePath("/settings/notifications")
  return { ok: true }
}
