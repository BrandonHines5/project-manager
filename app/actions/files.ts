"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const FileInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    category: z.enum(["house_plans", "plot_plan", "permit", "contract", "other"]),
    title: z.string().min(1).max(300),
    description: optStr,
    storage_path: z.string(),
    file_name: z.string(),
    file_type: optStr,
    file_size: z.number().nullish(),
  })
  .passthrough()

export type FileInputT = z.infer<typeof FileInput>

export async function saveProjectFile(input: FileInputT) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  const result = FileInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data

  if (parsed.id) {
    const { error } = await supabase
      .from("project_files")
      .update({
        category: parsed.category,
        title: parsed.title,
        description: parsed.description ?? null,
      })
      .eq("id", parsed.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from("project_files").insert({
      project_id: parsed.project_id,
      category: parsed.category,
      title: parsed.title,
      description: parsed.description ?? null,
      storage_path: parsed.storage_path,
      file_name: parsed.file_name,
      file_type: parsed.file_type ?? null,
      file_size: parsed.file_size ?? null,
      uploaded_by: profile.id,
    })
    if (error) throw new Error(error.message)
  }

  revalidatePath(`/projects/${parsed.project_id}/files`)
}

export async function deleteProjectFile({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: file } = await supabase
    .from("project_files")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle()
  const { error } = await supabase.from("project_files").delete().eq("id", id)
  if (error) throw new Error(error.message)
  if (file?.storage_path) {
    await supabase.storage.from("project-files").remove([file.storage_path])
  }
  revalidatePath(`/projects/${project_id}/files`)
}

export async function getSignedUrlsForFiles(paths: string[]) {
  if (paths.length === 0) return {}
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage
    .from("project-files")
    .createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}
