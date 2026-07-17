"use client"

import { useState, useTransition, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  X,
  Eye,
  EyeOff,
  Upload,
  FileIcon,
  ListTodo,
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
  postDailyLogComment,
  type DailyLogInputT,
} from "@/app/actions/daily-logs"
import { CommentsThread } from "@/components/comms/comments-thread"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import type { Tables, Enums } from "@/lib/db/types"
import type { DailyLogsData } from "@/app/(app)/projects/[id]/daily-logs/daily-logs-client"

type SubOnSite = { company_id: string; notes?: string | null }
type QuickTodo = { title: string; due_date: string; assignee: string }

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
  initial,
}: {
  open: boolean
  onClose: () => void
  mode: "create" | "edit"
  log?: Tables<"daily_logs">
  data: DailyLogsData
  // Seed values for a NEW log (create mode) — used by the AI "Draft client
  // update" flow to prefill the drafted notes and preset client visibility.
  // Ignored in edit mode (the existing log wins).
  initial?: { notes?: string; visibility?: Enums<"daily_log_visibility"> }
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)

  const [logDate, setLogDate] = useState(log?.log_date ?? todayISO())
  const [visibility, setVisibility] = useState<Enums<"daily_log_visibility">>(
    log?.visibility ?? initial?.visibility ?? "internal"
  )
  const [notes, setNotes] = useState(log?.notes ?? initial?.notes ?? "")
  // Labor hours — only relevant (and shown) on cost-plus jobs.
  const [hoursWorked, setHoursWorked] = useState(
    log?.hours_worked != null ? String(log.hours_worked) : ""
  )
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

  // Quick to-dos captured alongside a new log. Only offered when creating —
  // re-saving an edited log shouldn't re-create them. Assignee is encoded as
  // "p:<id>" (profile) or "c:<id>" (company), matching the server's XOR shape.
  const [todos, setTodos] = useState<QuickTodo[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Commit-on-select: picking a sub stages it immediately and the dropdown
  // resets to its placeholder (value=""). The earlier "pick then click +"
  // flow was easy to miss — users chose a sub, hit Save, and it was never
  // staged, so it silently vanished even though the log saved fine.
  function addSub(id: string) {
    if (!id) return
    if (subs.some((s) => s.company_id === id)) return
    setSubs([...subs, { company_id: id }])
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
      hours_worked:
        data.cost_plus && hoursWorked.trim() !== ""
          ? Number(hoursWorked)
          : null,
      subs_on_site: subs,
      attachments: attachments.map((a) => ({
        id: a.id,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
      })),
      todos:
        mode === "create"
          ? todos
              .filter((t) => t.title.trim() !== "")
              .map((t) => ({
                title: t.title.trim(),
                due_date: t.due_date || null,
                assignee_profile_id: t.assignee.startsWith("p:")
                  ? t.assignee.slice(2)
                  : null,
                assignee_company_id: t.assignee.startsWith("c:")
                  ? t.assignee.slice(2)
                  : null,
              }))
          : [],
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
    if (!confirm("Delete this job log and all its photos?")) return
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
              {mode === "edit" ? "Edit job log" : "New job log"}
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
            {data.cost_plus && (
              <Field label="Hours worked" hint="Cost-plus — your labor hours for the day">
                <Input
                  type="number"
                  step="0.25"
                  min="0"
                  max="24"
                  inputMode="decimal"
                  value={hoursWorked}
                  onChange={(e) => setHoursWorked(e.target.value)}
                  placeholder="e.g. 8"
                />
              </Field>
            )}
          </div>

          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={6}
              placeholder="What happened today? Weather, progress, issues, decisions, who showed up…"
            />
          </Field>

          {/* Quick to-dos (create only) */}
          {mode === "create" && (
            <TodosEditor
              todos={todos}
              onChange={setTodos}
              profiles={data.profiles}
              companies={data.companies}
            />
          )}

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
            <div className="mt-2">
              <Select
                value=""
                onChange={(e) => addSub(e.target.value)}
                aria-label="Add sub or vendor on site"
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
            {!attachments.some((a) => (a.file_type ?? "").startsWith("image/")) && (
              <p className="text-xs text-muted mt-1.5">
                No photos yet — consider adding a few site photos so the log tells
                the full story
                {visibility === "client"
                  ? "; homeowners love seeing progress on their build."
                  : "."}
              </p>
            )}
          </div>

          {/* Comments (edit only) — client questions land here too. */}
          {mode === "edit" && log && (
            <CommentsThread
              comments={data.comments
                .filter((c) => c.daily_log_id === log.id)
                .map((c) => ({
                  id: c.id,
                  author_name: c.author_name,
                  author_role: null,
                  body: c.body,
                  created_at: c.created_at,
                }))}
              meName={data.me_name}
              canPost
              placeholder="Reply to client / leave a note"
              onPost={(body) =>
                postDailyLogComment({
                  daily_log_id: log.id,
                  project_id: data.project_id,
                  body,
                })
              }
            />
          )}
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

function TodosEditor({
  todos,
  onChange,
  profiles,
  companies,
}: {
  todos: QuickTodo[]
  onChange: (v: QuickTodo[]) => void
  profiles: DailyLogsData["profiles"]
  companies: DailyLogsData["companies"]
}) {
  function update(idx: number, patch: Partial<QuickTodo>) {
    onChange(todos.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }
  return (
    <div>
      <Label>To-dos</Label>
      <p className="text-xs text-muted mt-0.5">
        Jot follow-ups from today. Each becomes a to-do on this project&apos;s
        schedule.
      </p>
      {todos.length > 0 && (
        <ul className="mt-2 space-y-2">
          {todos.map((t, i) => (
            <li
              key={i}
              className="grid grid-cols-1 sm:grid-cols-[1fr_140px_160px_auto] gap-2 items-center"
            >
              <Input
                value={t.title}
                onChange={(e) => update(i, { title: e.target.value })}
                placeholder="What needs doing?"
                aria-label="To-do title"
              />
              <Input
                type="date"
                value={t.due_date}
                onChange={(e) => update(i, { due_date: e.target.value })}
                aria-label="Due date"
              />
              <Select
                value={t.assignee}
                onChange={(e) => update(i, { assignee: e.target.value })}
                aria-label="Assignee"
                className="text-xs"
              >
                <option value="">Unassigned</option>
                <optgroup label="Team / users">
                  {profiles.map((p) => (
                    <option key={p.id} value={`p:${p.id}`}>
                      {p.full_name || p.email}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Subs / vendors">
                  {companies
                    .filter((c) => c.type !== "client")
                    .map((c) => (
                      <option key={c.id} value={`c:${c.id}`}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              </Select>
              <button
                type="button"
                onClick={() => onChange(todos.filter((_, idx) => idx !== i))}
                className="text-muted hover:text-danger cursor-pointer p-1 justify-self-start"
                aria-label="Remove to-do"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() =>
          onChange([...todos, { title: "", due_date: "", assignee: "" }])
        }
        className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <ListTodo className="h-3.5 w-3.5" /> Add to-do
      </button>
    </div>
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
            // Solid dark fill when selected — the old zinc-50 tint was easy
            // to miss, and "which visibility is on?" must be unmistakable.
            value === "internal"
              ? "border-zinc-800 bg-zinc-800 text-white"
              : "border-border-strong hover:bg-background/60"
          )}
        >
          <EyeOff
            className={cn(
              "h-5 w-5 mt-0.5",
              value === "internal" ? "text-zinc-300" : "text-zinc-600"
            )}
          />
          <div>
            <div className="font-medium text-sm">Internal only</div>
            <div
              className={cn(
                "text-xs",
                value === "internal" ? "text-zinc-300" : "text-muted"
              )}
            >
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
        className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-1.5 sm:p-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 cursor-pointer"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>
      <Input
        value={att.caption ?? ""}
        onChange={(e) => onCaption(e.target.value)}
        placeholder="Caption"
        className="mt-1 text-[11px] h-9 sm:h-7 px-2"
      />
    </div>
  )
}
