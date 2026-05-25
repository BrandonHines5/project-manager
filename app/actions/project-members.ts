"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const AddMemberInput = z.object({
  project_id: z.string().uuid(),
  profile_id: z.string().uuid(),
  role_on_project: z.string().nullable().optional(),
})

export async function addProjectMember(input: z.infer<typeof AddMemberInput>) {
  await requireStaff()
  const parsed = AddMemberInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("project_members").insert({
    project_id: parsed.project_id,
    profile_id: parsed.profile_id,
    role_on_project: parsed.role_on_project ?? null,
  })
  if (error && !error.message.includes("duplicate")) throw new Error(error.message)
  revalidatePath(`/projects/${parsed.project_id}`, "layout")
}

export async function removeProjectMember({
  project_id,
  profile_id,
}: {
  project_id: string
  profile_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("project_members")
    .delete()
    .eq("project_id", project_id)
    .eq("profile_id", profile_id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}`, "layout")
}
