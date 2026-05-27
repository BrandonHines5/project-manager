"use client"

import { useRef, useState, useTransition } from "react"
import { toast } from "sonner"
import { Paperclip, Trash2, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/input"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  addScheduleItemAttachment,
  deleteScheduleItemAttachment,
} from "@/app/actions/schedule"
import type { Tables } from "@/lib/db/types"

type Attachment = Tables<"schedule_item_attachments"> & {
  signed_url?: string | null
}

/**
 * Inline file uploader for a schedule item. Persists attachments
 * immediately when uploaded (browser → Storage → server action) rather
 * than staging them in form state, so closing the dialog without saving
 * doesn't lose files. Trade-off: orphan rows are possible if the user
 * uploads then deletes the parent item before save — the FK cascade
 * cleans those up.
 *
 * Requires `scheduleItemId` to be a persisted id. The dialog hides this
 * section when in "create" mode and shows a hint instead.
 */
export function AttachmentsEditor({
  scheduleItemId,
  projectId,
  attachments,
  onChange,
}: {
  scheduleItemId: string
  projectId: string
  attachments: Attachment[]
  onChange: (next: Attachment[]) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [pendingDelete, startDelete] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const fresh: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${projectId}/schedule/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from("project-files")
          .upload(path, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined,
          })
        if (upErr) {
          toast.error(`Upload failed: ${file.name} — ${upErr.message}`)
          continue
        }
        try {
          const { id } = await addScheduleItemAttachment({
            schedule_item_id: scheduleItemId,
            project_id: projectId,
            storage_path: path,
            file_name: file.name,
            file_type: file.type || null,
            file_size: file.size,
          })
          fresh.push({
            id,
            schedule_item_id: scheduleItemId,
            storage_bucket: "project-files",
            storage_path: path,
            file_name: file.name,
            file_type: file.type || null,
            file_size: file.size,
            caption: null,
            position: attachments.length + fresh.length,
            uploaded_by: null,
            created_at: new Date().toISOString(),
            signed_url: URL.createObjectURL(file),
          })
        } catch (e) {
          toast.error(
            `Couldn't attach ${file.name}: ${
              e instanceof Error ? e.message : "unknown"
            }`
          )
          // Roll the storage upload back so we don't leak an orphan file.
          await supabase.storage.from("project-files").remove([path])
        }
      }
      if (fresh.length) {
        onChange([...attachments, ...fresh])
        toast.success(
          `${fresh.length} file${fresh.length === 1 ? "" : "s"} attached`
        )
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function remove(id: string) {
    startDelete(async () => {
      try {
        await deleteScheduleItemAttachment({ id, project_id: projectId })
        onChange(attachments.filter((a) => a.id !== id))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Attachments</Label>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="text-xs text-brand-600 hover:underline cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Paperclip className="h-3 w-3" />
          {uploading ? "Uploading…" : "Add files"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => onPickFiles(e.target.files)}
        />
      </div>
      {attachments.length === 0 ? (
        <p className="mt-1 text-xs text-muted">No attachments yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border border border-border rounded-md text-sm">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="px-3 py-2 flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{a.file_name}</div>
                {a.file_size != null && (
                  <div className="text-xs text-muted">
                    {formatBytes(a.file_size)}
                  </div>
                )}
              </div>
              {a.signed_url && (
                <a
                  href={a.signed_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted hover:text-brand-600 p-1"
                  aria-label="Open"
                  title="Open"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button
                type="button"
                onClick={() => remove(a.id)}
                disabled={pendingDelete}
                className="text-muted hover:text-danger p-1 cursor-pointer"
                aria-label="Remove attachment"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentsCreatePlaceholder() {
  return (
    <div>
      <Label>Attachments</Label>
      <p className="mt-1 text-xs text-muted">
        Save the to-do first to attach files.
      </p>
    </div>
  )
}

export function AttachmentsEditorEmpty() {
  return <Button variant="ghost" disabled />
}
