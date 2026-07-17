import type { createSupabaseServerClient } from "@/lib/supabase/server"

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>

export type LinkedAttachmentInput = {
  project_file_id?: string | null
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
}

/**
 * Canonicalize "Link from Files" attachments before they're persisted on a
 * bid package or PO. `project_file_id` and the blob metadata arrive from the
 * client, so a tampered action call could pair a valid id with a different
 * blob path, or reference another project's document, and expose it through
 * the bid/PO token pages. Re-load every referenced project_files row under
 * the caller's RLS session, require it to belong to THIS project, and
 * overwrite the attachment's path/name/type/size from the database row —
 * client-supplied metadata on linked rows is never trusted.
 */
export async function canonicalizeLinkedAttachments<
  T extends LinkedAttachmentInput,
>(supabase: SupabaseServer, projectId: string, attachments: T[]): Promise<T[]> {
  const linkedIds = [
    ...new Set(
      attachments
        .map((a) => a.project_file_id)
        .filter((x): x is string => !!x)
    ),
  ]
  if (!linkedIds.length) return attachments

  const { data, error } = await supabase
    .from("project_files")
    .select("id, project_id, storage_path, file_name, file_type, file_size")
    .in("id", linkedIds)
  if (error) throw new Error(error.message)
  const byId = new Map((data ?? []).map((f) => [f.id, f]))

  return attachments.map((a) => {
    if (!a.project_file_id) return a
    const f = byId.get(a.project_file_id)
    if (!f || f.project_id !== projectId) {
      throw new Error("Linked file not found in this project.")
    }
    return {
      ...a,
      storage_path: f.storage_path,
      file_name: f.file_name,
      file_type: f.file_type,
      file_size: f.file_size,
    }
  })
}
