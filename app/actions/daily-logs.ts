"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const DailyLogInput = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  log_date: z.string().min(1, "Required"),
  visibility: z.enum(["internal", "client"]).default("internal"),
  notes: z.string().optional().nullable(),
  subs_on_site: z
    .array(
      z.object({
        company_id: z.string().uuid(),
        notes: z.string().optional().nullable(),
      })
    )
    .default([]),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        storage_path: z.string(),
        file_name: z.string(),
        file_type: z.string().optional().nullable(),
        file_size: z.number().optional().nullable(),
        caption: z.string().optional().nullable(),
      })
    )
    .default([]),
})

export type DailyLogInputT = z.infer<typeof DailyLogInput>

export async function saveDailyLog(input: DailyLogInputT) {
  const profile = await requireStaff()
  const parsed = DailyLogInput.parse(input)
  const supabase = await createSupabaseServerClient()

  let id = parsed.id
  const baseRow = {
    project_id: parsed.project_id,
    log_date: parsed.log_date,
    visibility: parsed.visibility,
    notes: parsed.notes ?? null,
  }

  if (id) {
    const { error } = await supabase
      .from("daily_logs")
      .update(baseRow)
      .eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase
      .from("daily_logs")
      .insert({ ...baseRow, created_by: profile.id })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    id = data.id
  }

  // Replace subs_on_site
  await supabase.from("daily_log_subs_on_site").delete().eq("daily_log_id", id)
  if (parsed.subs_on_site.length) {
    const rows = parsed.subs_on_site.map((s) => ({
      daily_log_id: id!,
      company_id: s.company_id,
      notes: s.notes ?? null,
    }))
    const { error } = await supabase
      .from("daily_log_subs_on_site")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  // Reconcile attachments: keep existing IDs that were retained; insert new;
  // delete missing.
  const { data: existing } = await supabase
    .from("daily_log_attachments")
    .select("id, storage_path")
    .eq("daily_log_id", id)
  const keepIds = new Set(parsed.attachments.map((a) => a.id).filter(Boolean))
  const toDelete = (existing ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    await supabase
      .from("daily_log_attachments")
      .delete()
      .in(
        "id",
        toDelete.map((d) => d.id)
      )
    await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
  }

  const newOnes = parsed.attachments.filter((a) => !a.id)
  if (newOnes.length) {
    const startPos = existing?.length ?? 0
    const rows = newOnes.map((a, i) => ({
      daily_log_id: id!,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: a.file_type ?? null,
      file_size: a.file_size ?? null,
      caption: a.caption ?? null,
      position: startPos + i,
    }))
    const { error } = await supabase
      .from("daily_log_attachments")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  // Update captions on retained attachments
  const retained = parsed.attachments.filter((a) => a.id)
  for (const a of retained) {
    await supabase
      .from("daily_log_attachments")
      .update({ caption: a.caption ?? null })
      .eq("id", a.id!)
  }

  revalidatePath(`/projects/${parsed.project_id}/daily-logs`)
  return { id }
}

export async function deleteDailyLog({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  // Collect file paths first so we can also remove from storage.
  const { data: atts } = await supabase
    .from("daily_log_attachments")
    .select("storage_path")
    .eq("daily_log_id", id)
  const paths = (atts ?? []).map((a) => a.storage_path)

  const { error } = await supabase.from("daily_logs").delete().eq("id", id)
  if (error) throw new Error(error.message)

  if (paths.length) {
    await supabase.storage.from("project-files").remove(paths)
  }

  revalidatePath(`/projects/${project_id}/daily-logs`)
}

/**
 * Returns short-lived signed URLs for the given storage paths so the browser
 * can render images from the private bucket.
 */
export async function getSignedUrls(paths: string[]) {
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
