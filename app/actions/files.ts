"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession, requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const FileInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    category: z.enum([
      "house_plans",
      "plot_plan",
      "permit",
      "contract",
      "quotes",
      "other",
    ]),
    title: z.string().min(1).max(300),
    description: optStr,
    storage_path: z.string(),
    file_name: z.string(),
    file_type: optStr,
    file_size: z.number().nullish(),
    // Per-file client visibility. Omitted: edits keep the stored value,
    // fresh uploads default true (clients saw everything before the flag
    // existed), revisions inherit the prior head's value.
    client_visible: z.boolean().optional(),
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
        ...(parsed.client_visible !== undefined
          ? { client_visible: parsed.client_visible }
          : {}),
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
  let inheritedVisible: boolean | null = null
  if (parsed.replaces_id) {
    const { data: prior, error: priorErr } = await supabase
      .from("project_files")
      .select("id, project_id, parent_file_id, version, client_visible")
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
    // A shared plan stays shared (and a hidden one hidden) across revisions
    // unless the uploader explicitly changes it.
    inheritedVisible = prior.client_visible

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
    client_visible: parsed.client_visible ?? inheritedVisible ?? true,
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
  // The Storage object is NOT removed here: the delete is captured into
  // deleted_items (0088) so it can be restored from the History tab, and the
  // trash purge removes the object when the entry expires unrestored.
  revalidatePath(`/projects/${project_id}/files`)
}

/**
 * Archive or restore a plan/document. Archiving is a soft move: the row and
 * its storage object stay put (so client signed-URL links keep working and
 * the revision chain is intact) — the UI just files it under "Archived" and
 * drops it from the active list and gallery. Restoring clears the timestamp.
 */
const ArchiveInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  archived: z.boolean(),
})

export async function setProjectFileArchived(input: z.input<typeof ArchiveInput>) {
  const result = ArchiveInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid archive payload at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, project_id, archived } = result.data
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("project_files")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("project_id", project_id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/files`)
}

/**
 * Show or hide a file from the client portal. Enforcement is RLS
 * (pf_client_read + the storage-object policy both check client_visible) —
 * this just flips the flag.
 */
const VisibilityInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  visible: z.boolean(),
})

export async function setProjectFileClientVisibility(
  input: z.input<typeof VisibilityInput>
) {
  const result = VisibilityInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid visibility payload at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, project_id, visible } = result.data
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("project_files")
    .update({ client_visible: visible })
    .eq("id", id)
    .eq("project_id", project_id)
  if (error) throw new Error(error.message)
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

// ---- Media tagging -------------------------------------------------------
//
// The gallery aggregates four sources (project_files, daily_log_attachments,
// decision_attachments, schedule_item_attachments). Each has its own tags
// column (migration 0030). This single entry point dispatches by source so
// the client doesn't have to know the storage shape — it just says "tag
// this media row".

const SourceEnum = z.enum([
  "project_file",
  "daily_log_attachment",
  "decision_attachment",
  "schedule_item_attachment",
])
type TagSource = z.infer<typeof SourceEnum>

const TagUpdateInput = z.object({
  project_id: z.string(),
  source: SourceEnum,
  id: z.string(),
  // Per-tag normalization (lower + trim) is done in the action — but the
  // DB trigger validate_media_tags will reject if we forget, so this is
  // defence-in-depth, not the only line of defence.
  tags: z
    .array(z.string())
    .max(20, "At most 20 tags per attachment")
    .transform((arr) =>
      Array.from(
        new Set(
          arr
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= 1 && t.length <= 40)
        )
      ).sort()
    ),
})

const TABLE_BY_SOURCE: Record<TagSource, string> = {
  project_file: "project_files",
  daily_log_attachment: "daily_log_attachments",
  decision_attachment: "decision_attachments",
  schedule_item_attachment: "schedule_item_attachments",
}

export async function setMediaTags(input: z.input<typeof TagUpdateInput>) {
  await requireStaff()
  const parsed = TagUpdateInput.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Invalid tag payload at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const supabase = await createSupabaseServerClient()
  // Resolve the target row's project before the write so we can refuse
  // cross-project tag edits (CodeRabbit #32). The *_staff_all RLS
  // policies on the attachment tables only check is_staff() — without
  // this server-side scope check, any staff member could tag an
  // attachment in a project they don't belong to just by knowing its
  // id. Project_files carries project_id directly; the three nested
  // attachments resolve via their parent. Daily-log and decision
  // attachments fail-closed if their parent doesn't match.
  const targetProjectId = await resolveAttachmentProjectId(
    supabase,
    parsed.data.source,
    parsed.data.id
  )
  if (!targetProjectId) {
    throw new Error("Attachment not found or not in this project.")
  }
  if (targetProjectId !== parsed.data.project_id) {
    throw new Error("Cross-project tag updates are not allowed.")
  }

  const table = TABLE_BY_SOURCE[parsed.data.source]
  // Cast through `as any` because the table name is a runtime-resolved union;
  // each member has the same { tags: string[] } shape so the runtime call is
  // safe but the union of Update types is too wide for Supabase's overload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = (supabase.from(table as any) as any).update({
    tags: parsed.data.tags,
  })
  const { error } = await builder.eq("id", parsed.data.id)
  if (error) throw new Error(error.message)
  // Files page is the only one that renders the unified gallery; daily-logs
  // and decisions pages don't, so a single revalidatePath here is enough.
  revalidatePath(`/projects/${parsed.data.project_id}/files`)
}

async function resolveAttachmentProjectId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  source: TagSource,
  id: string
): Promise<string | null> {
  switch (source) {
    case "project_file": {
      const { data } = await supabase
        .from("project_files")
        .select("project_id")
        .eq("id", id)
        .maybeSingle()
      return data?.project_id ?? null
    }
    case "daily_log_attachment": {
      const { data } = await supabase
        .from("daily_log_attachments")
        .select("daily_logs!inner(project_id)")
        .eq("id", id)
        .maybeSingle()
      return (
        (data as unknown as { daily_logs: { project_id: string } } | null)
          ?.daily_logs.project_id ?? null
      )
    }
    case "decision_attachment": {
      const { data } = await supabase
        .from("decision_attachments")
        .select("decisions!inner(project_id)")
        .eq("id", id)
        .maybeSingle()
      return (
        (data as unknown as { decisions: { project_id: string } } | null)
          ?.decisions.project_id ?? null
      )
    }
    case "schedule_item_attachment": {
      const { data } = await supabase
        .from("schedule_item_attachments")
        .select("schedule_items!inner(project_id)")
        .eq("id", id)
        .maybeSingle()
      return (
        (data as unknown as { schedule_items: { project_id: string } } | null)
          ?.schedule_items.project_id ?? null
      )
    }
  }
}

export async function getSignedUrlsForFiles(paths: string[]) {
  await requireSession()
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
