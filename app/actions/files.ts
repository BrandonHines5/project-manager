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
    // When set, the new upload is treated as a revision of the referenced
    // file. The previous head's is_current flips false; the chain root
    // (parent_file_id) stays the original v1, so a "view history" lookup is
    // a single index hit on parent_file_id.
    replaces_id: optStr,
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
    // Title/description edit; never changes storage path, version, or chain.
    const { error } = await supabase
      .from("project_files")
      .update({
        category: parsed.category,
        title: parsed.title,
        description: parsed.description ?? null,
      })
      .eq("id", parsed.id)
    if (error) throw new Error(error.message)
    revalidatePath(`/projects/${parsed.project_id}/files`)
    return
  }

  // Fresh upload. If replaces_id is set, treat it as a new revision: look
  // up the row, derive the chain root and the next version number, then
  // demote the previous head before inserting the new row.
  let parentFileId: string | null = null
  let nextVersion = 1
  if (parsed.replaces_id) {
    const { data: prior, error: priorErr } = await supabase
      .from("project_files")
      .select("id, project_id, parent_file_id, version")
      .eq("id", parsed.replaces_id)
      .maybeSingle()
    if (priorErr) throw new Error(priorErr.message)
    if (!prior) {
      throw new Error("The file you tried to replace doesn't exist or isn't visible.")
    }
    if (prior.project_id !== parsed.project_id) {
      throw new Error("Cross-project revision isn't allowed.")
    }
    // Flatten the chain: even if `prior` itself was already v3 in a chain,
    // its parent_file_id is the root v1. Use that so a future v5 still
    // points back to the original.
    parentFileId = prior.parent_file_id ?? prior.id
    nextVersion = prior.version + 1

    // Demote the prior head BEFORE the insert so the partial index on
    // (project_id, category) where is_current = true never sees two heads
    // for the same chain mid-transaction.
    const { error: demoteErr } = await supabase
      .from("project_files")
      .update({ is_current: false })
      .eq("id", parsed.replaces_id)
    if (demoteErr) throw new Error(demoteErr.message)
  }

  const { error: insErr } = await supabase.from("project_files").insert({
    project_id: parsed.project_id,
    category: parsed.category,
    title: parsed.title,
    description: parsed.description ?? null,
    storage_path: parsed.storage_path,
    file_name: parsed.file_name,
    file_type: parsed.file_type ?? null,
    file_size: parsed.file_size ?? null,
    uploaded_by: profile.id,
    parent_file_id: parentFileId,
    version: nextVersion,
    is_current: true,
  })
  if (insErr) {
    // Roll back the demote on insert failure so we don't strand the chain
    // with no current head.
    if (parsed.replaces_id) {
      await supabase
        .from("project_files")
        .update({ is_current: true })
        .eq("id", parsed.replaces_id)
    }
    throw new Error(insErr.message)
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

  // If we're deleting the current head of a chain, promote the most recent
  // older revision to the new head. Without this, a v3-delete on a B→C
  // chain leaves the chain headless (every row is_current=false) and the
  // plans gallery loses the file entirely.
  const { data: file } = await supabase
    .from("project_files")
    .select("id, project_id, parent_file_id, version, is_current, storage_path")
    .eq("id", id)
    .maybeSingle()
  if (!file) return
  const { error } = await supabase.from("project_files").delete().eq("id", id)
  if (error) throw new Error(error.message)
  if (file.is_current) {
    const chainRoot = file.parent_file_id ?? file.id
    const { data: candidates } = await supabase
      .from("project_files")
      .select("id, version")
      .or(`id.eq.${chainRoot},parent_file_id.eq.${chainRoot}`)
      .order("version", { ascending: false })
      .limit(1)
    const newHead = candidates?.[0]
    if (newHead) {
      await supabase
        .from("project_files")
        .update({ is_current: true })
        .eq("id", newHead.id)
    }
  }
  if (file.storage_path) {
    await supabase.storage.from("project-files").remove([file.storage_path])
  }
  revalidatePath(`/projects/${project_id}/files`)
}

/**
 * Returns every revision (current + history) belonging to the same chain as
 * the supplied file id. The result is sorted with v1 first → newest last so
 * the UI can render a left-to-right timeline.
 */
export async function getFileVersions(input: {
  project_id: string
  file_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: target } = await supabase
    .from("project_files")
    .select("id, parent_file_id, project_id")
    .eq("id", input.file_id)
    .maybeSingle()
  if (!target || target.project_id !== input.project_id) return []
  const root = target.parent_file_id ?? target.id
  const { data, error } = await supabase
    .from("project_files")
    .select(
      "id, version, title, file_name, file_type, file_size, storage_path, is_current, created_at, uploaded_by"
    )
    .or(`id.eq.${root},parent_file_id.eq.${root}`)
    .order("version", { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
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
