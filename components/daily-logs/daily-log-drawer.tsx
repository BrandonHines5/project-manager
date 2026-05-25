"use client"

import { useState, useTransition, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  Eye,
  EyeOff,
  Upload,
  FileIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Textarea, Select, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn, todayISO } from "@/lib/utils"
import {
  saveDailyLog,
  deleteDailyLog,
  type DailyLogInputT,
} from "@/app/actions/daily-logs"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import type { Tables, Enums } from "@/lib/db/types"
import type { DailyLogsData } from "@/app/(app)/projects/[id]/daily-logs/daily-logs-client"

type SubOnSite = { company_id: string; notes?: string | null }

type Attachment = {
  id?: string
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
  caption?: string | null
  preview_url?: string
}

export function DailyLogDrawer({
  open,
  onClose,
  mode,
  log,
  data,
}: {
  open: boolean
  onClose: () => void
  mode: "create" | "edit"
  log?: Tables<"daily_logs">
  data: DailyLogsData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)

  const [logDate, setLogDate] = useState(log?.log_date ?? todayISO())
  const [visibility, setVisibility] = useState<Enums<"daily_log_visibility">>(
    log?.visibility ?? "internal"
  )
  const [notes, setNotes] = useState(log?.notes ?? "")
  const [subs, setSubs] = useState<SubOnSite[]>(() => {
    if (!log) return []
    return data.subs_on_site
      .filter((s) => s.daily_log_id === log.id)
      .map((s) => ({ company_id: s.company_id, notes: s.notes }))
  })
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    if (!log) return []
    return data.attachments
      .filter((a) => a.daily_log_id === log.id)
      .map((a) => ({
        id: a.id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
        preview_url: data.signed_urls[a.storage_path],
      }))
  })

  const [selCompany, setSelCompany] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  function addSub() {
    if (!selCompany) return
    if (subs.some((s) => s.company_id === selCompany)) return
    setSubs([...subs, { company_id: selCompany }])
    setSelCompany("")
  }
  function removeSub(idx: number) {
    setSubs(subs.filter((_, i) => i !== idx))
  }

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const newAtts: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${data.project_id}/daily-logs/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.${ext}`
        const { error } = await supabase.storage
          .from("project-files")
          .upload(path, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined,
          })
        if (error) {
          toast.error(`Upload failed: ${file.name} - ${error.message}`)
          continue
        }
        newAtts.push({
          storage_path: path,
          file_name: file.name,
          file_type: file.type || null,
          file_size: file.size,
          preview_url: URL.createObjectURL(file),
        })
      }
      if (newAtts.length) {
        setAttachments([...attachments, ...newAtts])
        toast.success(
          `${newAtts.length} file${newAtts.length === 1 ? "" : "s"} uploaded`
        )
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function removeAttachment(idx: number) {
    setAttachments(attachments.filter((_, i) => i !== idx))
  }

  function updateCaption(idx: number, caption: string) {
    setAttachments(
      attachments.map((a, i) => (i === idx ? { ...a, caption } : a))
    )
  }

  async function handleSave() {
    if (!logDate) {
      toast.error("Date is required")
      return
    }
    const payload: DailyLogInputT = {
      id: log?.id,
      project_id: data.project_id,
      log_date: logDate,
      visibility,
      notes: notes || null,
      subs_on_site: subs,
      attachments: attachments.map((a) => ({
        id: a.id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
      })),
    }
    startTransition(async () => {
      try {
        await saveDailyLog(payload)
        toast.success(mode === "edit" ? "Saved" : "Created")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  async function handleDelete() {
    if (!log) return
    if (!confirm("Delete this daily log and all its photos?")) return
    startTransition(async () => {
      try {
        await deleteDailyLog({ id: log.id, project_id: data.project_id })
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <div>
            <DialogTitle>
              {mode === "edit" ? "Edit daily log" : "New daily log"}
            </DialogTitle>
            <DialogDescription>
              Capture what happened on site today. Photos and notes can be
              client-visible or kept internal.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <VisibilityToggle value={visibility} onChange={setVisibility} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Date">
              <Input
                type="date"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={6}
              placeholder="What happened today? Weather, progress, issues, decisions, who showed up…"
            />
          </Field>

          {/* Subs on site */}
          <div>
            <Label>Subs / vendors on site</Label>
            {subs.length > 0 && (
              <ul className="mt-1 border border-border rounded-md divide-y divide-border text-sm">
                {subs.map((s, i) => {
                  const c = data.companies.find((x) => x.id === s.company_id)
                  return (
                    <li
                      key={s.company_id}
                      className="px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div className="flex-1">
                        <div className="font-medium">
                          {c?.name ?? "?"}
                          {c?.trade_category && (
                            <span className="ml-1 text-muted text-xs">
                              ({c.trade_category})
                            </span>
                          )}
                        </div>
                        <Input
                          value={s.notes ?? ""}
                          onChange={(e) => {
                            const next = [...subs]
                            next[i] = { ...s, notes: e.target.value }
                            setSubs(next)
                          }}
                          placeholder="Optional notes about their work today"
                          className="mt-1 text-xs"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSub(i)}
                        className="text-muted hover:text-danger cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <Select
                value={selCompany}
                onChange={(e) => setSelCompany(e.target.value)}
              >
                <option value="">Add sub / vendor…</option>
                {data.companies
                  .filter((c) => !subs.some((s) => s.company_id === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.trade_category ? ` (${c.trade_category})` : ""}
                    </option>
                  ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                onClick={addSub}
                disabled={!selCompany}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Photos */}
          <div>
            <Label>Photos &amp; files</Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,video/*"
              className="hidden"
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {attachments.map((a, i) => (
                <AttachmentTile
                  key={a.storage_path}
                  att={a}
                  onRemove={() => removeAttachment(i)}
                  onCaption={(c) => updateCaption(i, c)}
                />
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="aspect-square rounded-md border border-dashed border-border-strong flex flex-col items-center justify-center text-muted hover:border-brand-500 hover:text-brand-600 cursor-pointer text-xs gap-1 disabled:opacity-50"
              >
                <Upload className="h-5 w-5" />
                {uploading ? "Uploading…" : "Add files"}
              </button>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          {mode === "edit" && log && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleDelete}
              disabled={pending}
              className="mr-auto text-danger hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={pending || uploading}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VisibilityToggle({
  value,
  onChange,
}: {
  value: Enums<"daily_log_visibility">
  onChange: (v: Enums<"daily_log_visibility">) => void
}) {
  return (
    <div>
      <Label>Visibility</Label>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange("internal")}
          className={cn(
            "rounded-md border p-3 text-left cursor-pointer flex gap-3 items-start",
            value === "internal"
              ? "border-zinc-700 bg-zinc-50"
              : "border-border-strong hover:bg-background/60"
          )}
        >
          <EyeOff className="h-5 w-5 mt-0.5 text-zinc-600" />
          <div>
            <div className="font-medium text-sm">Internal only</div>
            <div className="text-xs text-muted">
              Hidden from the client portal
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onChange("client")}
          className={cn(
            "rounded-md border p-3 text-left cursor-pointer flex gap-3 items-start",
            value === "client"
              ? "border-brand-500 bg-brand-50"
              : "border-border-strong hover:bg-background/60"
          )}
        >
          <Eye className="h-5 w-5 mt-0.5 text-brand-600" />
          <div>
            <div className="font-medium text-sm">Client visible</div>
            <div className="text-xs text-muted">
              Shown on the homeowner&apos;s portal
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

function AttachmentTile({
  att,
  onRemove,
  onCaption,
}: {
  att: Attachment
  onRemove: () => void
  onCaption: (c: string) => void
}) {
  const isImage = att.file_type?.startsWith("image/") ?? false
  return (
    <div className="relative group">
      <div className="aspect-square rounded-md overflow-hidden border border-border bg-background flex items-center justify-center">
        {isImage && att.preview_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={att.preview_url}
            alt={att.file_name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center text-muted text-[10px] p-1">
            <FileIcon className="h-6 w-6 mb-1" />
            <span className="truncate w-full text-center" title={att.file_name}>
              {att.file_name}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 cursor-pointer"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>
      <Input
        value={att.caption ?? ""}
        onChange={(e) => onCaption(e.target.value)}
        placeholder="Caption"
        className="mt-1 text-[11px] h-7 px-2"
      />
    </div>
  )
}
