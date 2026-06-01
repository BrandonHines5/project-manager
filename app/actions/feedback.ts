"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"
import { FEEDBACK_TYPES, FEEDBACK_STATUSES } from "@/lib/feedback"

const optStr = z.string().nullish()

const SubmitInput = z.object({
  request_type: z.enum(FEEDBACK_TYPES).default("Feature Request"),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).nullish(),
})
export type SubmitFeedbackInput = z.infer<typeof SubmitInput>

// Any signed-in user (staff, trade, client) can file a request. We stamp the
// submitter from the session — the client never gets to claim someone else's
// name, and RLS (feedback_insert_self) double-checks submitted_by_id == uid.
export async function submitFeedback(input: SubmitFeedbackInput) {
  const profile = await requireSession()
  const result = SubmitInput.safeParse(input)
  if (!result.success) {
    throw new Error(result.error.issues[0].message)
  }
  const { request_type, title, description } = result.data
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("feedback_requests").insert({
    submitted_by_id: profile.id,
    submitted_by: profile.full_name,
    submitted_by_email: profile.email,
    request_type,
    title,
    description: description && description !== "" ? description : null,
  })
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
}

const StatusInput = z.object({
  id: z.string().uuid(),
  status: z.enum(FEEDBACK_STATUSES),
})

// Triage is staff-only. RLS would reject a non-staff update too, but failing
// fast here gives a clean error instead of a silent zero-row update.
export async function updateFeedbackStatus(input: z.infer<typeof StatusInput>) {
  await requireStaff()
  const result = StatusInput.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0].message)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("feedback_requests")
    .update({ status: result.data.status })
    .eq("id", result.data.id)
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
}

const NotesInput = z.object({
  id: z.string().uuid(),
  admin_notes: optStr,
})

export async function updateFeedbackNotes(input: z.infer<typeof NotesInput>) {
  await requireStaff()
  const result = NotesInput.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0].message)
  const notes = result.data.admin_notes?.trim()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("feedback_requests")
    .update({ admin_notes: notes && notes !== "" ? notes : null })
    .eq("id", result.data.id)
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
}

export async function deleteFeedback(input: { id: string }) {
  await requireStaff()
  const id = z.string().uuid().parse(input.id)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("feedback_requests")
    .delete()
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/feedback")
}
