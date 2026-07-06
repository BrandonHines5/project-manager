"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"

const AssignInput = z.object({
  communication_id: z.string().min(1),
  project_id: z.string().min(1),
})

/**
 * Attach an unmatched (needs_review) communication to a project. Staff-only —
 * RLS backs this up (comms_staff_all is the only write policy).
 */
export async function assignCommunication(input: {
  communication_id: string
  project_id: string
}) {
  await requireStaff()
  const parsed = AssignInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("communications")
    .update({ project_id: parsed.project_id, status: "logged" })
    .eq("id", parsed.communication_id)
  if (error) throw new Error(error.message)
  revalidatePath("/communications")
  revalidatePath(`/projects/${parsed.project_id}/communications`)
}

/** Dismiss an unmatched communication (wrong number, spam, personal). */
export async function ignoreCommunication(input: { communication_id: string }) {
  await requireStaff()
  const id = z.string().min(1).parse(input.communication_id)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("communications")
    .update({ status: "ignored" })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/communications")
}
