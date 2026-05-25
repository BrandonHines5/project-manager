"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const AddMemberInput = z
  .object({
    project_id: z.string(),
    profile_id: z.string(),
    role_on_project: z.string().nullish(),
  })
  .passthrough()

export async function addProjectMember(input: z.infer<typeof AddMemberInput>) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const result = AddMemberInput.safeParse(input)
  if (!result.success) {
    await supabase.from("debug_log").insert({
      tag: "addProjectMember:zod_error",
      payload: JSON.parse(JSON.stringify({ issues: result.error.issues, input })),
    })
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const { error } = await supabase.from("project_members").insert({
    project_id: parsed.project_id,
    profile_id: parsed.profile_id,
    role_on_project: parsed.role_on_project || null,
  })
  // Tolerate duplicate-key — already a member is a no-op success.
  if (error && error.code !== "23505") throw new Error(error.message)
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
