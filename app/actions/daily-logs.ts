"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"

const optStr = z.string().nullish()

const DailyLogInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    log_date: z.string().min(1, "Required"),
    visibility: z.enum(["internal", "client"]).default("internal"),
    notes: optStr,
    subs_on_site: z
      .array(
        z.object({
          company_id: z.string(),
          notes: optStr,
        })
      )
      .default([]),
    attachments: z
      .array(
        z.object({
          id: optStr,
          storage_path: z.string(),
          file_name: z.string(),
          file_type: optStr,
          file_size: z.number().nullish(),
          caption: optStr,
        })
      )
      .default([]),
  })
  .passthrough()

export type DailyLogInputT = z.infer<typeof DailyLogInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

export async function saveDailyLog(input: DailyLogInputT) {
  const profile = await requireStaff()
  const result = DailyLogInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  let id = nz(parsed.id)
  const baseRow = {
    project_id: parsed.project_id,
    log_date: parsed.log_date,
    visibility: parsed.visibility,
    notes: nz(parsed.notes),
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
    const rows = parsed.subs_on_site
      .filter((s) => !!s.company_id)
      .map((s) => ({
        daily_log_id: id!,
        company_id: s.company_id,
        notes: nz(s.notes),
      }))
    if (rows.length) {
      const { error } = await supabase
        .from("daily_log_subs_on_site")
        .insert(rows)
      if (error) throw new Error(error.message)
    }
  }

  // Reconcile attachments
  const { data: existing } = await supabase
    .from("daily_log_attachments")
    .select("id, storage_path")
    .eq("daily_log_id", id)
  const keepIds = new Set(
    parsed.attachments
      .map((a) => nz(a.id))
      .filter((x): x is string => !!x)
  )
  const toDelete = (existing ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    const { error: rmErr } = await supabase
      .from("daily_log_attachments")
      .delete()
      .in(
        "id",
        toDelete.map((d) => d.id)
      )
    if (rmErr) throw new Error(rmErr.message)
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
    if (storageErr) {
      console.warn(
        "[saveDailyLog] storage cleanup failed (non-fatal):",
        storageErr.message
      )
    }
  }

  const newOnes = parsed.attachments.filter((a) => !nz(a.id))
  if (newOnes.length) {
    const startPos = existing?.length ?? 0
    const rows = newOnes.map((a, i) => ({
      daily_log_id: id!,
      storage_path: a.storage_path,
      file_name: a.file_name,
      file_type: nz(a.file_type),
      file_size: a.file_size ?? null,
      caption: nz(a.caption),
      position: startPos + i,
    }))
    const { error } = await supabase
      .from("daily_log_attachments")
      .insert(rows)
    if (error) throw new Error(error.message)
  }

  const retained = parsed.attachments.filter((a) => nz(a.id))
  for (const a of retained) {
    const { error: capErr } = await supabase
      .from("daily_log_attachments")
      .update({ caption: nz(a.caption) })
      .eq("id", a.id!)
    if (capErr) throw new Error(capErr.message)
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
