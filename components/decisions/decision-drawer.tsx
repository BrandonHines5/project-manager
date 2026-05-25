"use client"

import { useState, useTransition, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Trash2,
  Plus,
  X,
  Send,
  Check,
  Upload,
  FileIcon,
  MessageSquare,
  Sparkles,
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
import { Avatar } from "@/components/ui/avatar"
import { cn, formatDate } from "@/lib/utils"
import {
  saveDecision,
  deleteDecision,
  postComment,
  type DecisionInputT,
} from "@/app/actions/decisions"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  KindChip,
  StatusBadge,
  CostDelta,
} from "@/app/(app)/projects/[id]/decisions/decisions-client"
import type { Tables, Enums } from "@/lib/db/types"
import type { DecisionsData } from "@/app/(app)/projects/[id]/decisions/decisions-client"

type Followup = {
  id?: string
  title: string
  assignee_profile_id?: string | null
  assignee_company_id?: string | null
  due_offset_days: number
  notes?: string | null
}

type Attachment = {
  id?: string
  storage_path: string
  file_name: string
  file_type?: string | null
  file_size?: number | null
  caption?: string | null
  preview_url?: string
}

export function DecisionDrawer({
  open,
  onClose,
  mode,
  decision,
  defaultKind,
  data,
}: {
  open: boolean
  onClose: () => void
  mode: "create" | "edit"
  decision?: Tables<"decisions">
  defaultKind?: "change_order" | "selection"
  data: DecisionsData
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)

  const initialKind: Enums<"decision_kind"> =
    decision?.kind ?? defaultKind ?? "change_order"

  const [kind, setKind] = useState<Enums<"decision_kind">>(initialKind)
  const [title, setTitle] = useState(decision?.title ?? "")
  const [description, setDescription] = useState(decision?.description ?? "")
  const [costDelta, setCostDelta] = useState<string>(
    decision?.cost_delta != null ? String(decision.cost_delta) : ""
  )
  const [status, setStatus] = useState<Enums<"decision_status">>(
    decision?.status ?? "draft"
  )
  const [followups, setFollowups] = useState<Followup[]>(() => {
    if (!decision) return []
    return data.followups
      .filter((f) => f.decision_id === decision.id)
      .map((f) => ({
        id: f.id,
        title: f.title,
        assignee_profile_id: f.assignee_profile_id,
        assignee_company_id: f.assignee_company_id,
        due_offset_days: f.due_offset_days,
        notes: f.notes,
      }))
  })
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    if (!decision) return []
    return data.attachments
      .filter((a) => a.decision_id === decision.id)
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

  const fileInputRef = useRef<HTMLInputElement>(null)

  const isClient = data.role === "client"
  const canEdit = data.role === "staff"
  const myComments = decision
    ? data.comments.filter((c) => c.decision_id === decision.id)
    : []

  async function onPickFiles(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const newAtts: Attachment[] = []
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${data.project_id}/decisions/${Date.now()}-${Math.random()
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
        toast.success(`${newAtts.length} file${newAtts.length === 1 ? "" : "s"} uploaded`)
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function saveWithStatus(newStatus: Enums<"decision_status">) {
    // Don't optimistically advance the visible status until the save
    // succeeds — otherwise a failed approval still shows "Approved" in the UI
    // and confuses the user. handleSave will update local status on success.
    handleSave(newStatus)
  }

  function handleSave(overrideStatus?: Enums<"decision_status">) {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    const payload: DecisionInputT = {
      id: decision?.id,
      project_id: data.project_id,
      kind,
      title: title.trim(),
      description: description || null,
      cost_delta: costDelta === "" ? null : Number(costDelta),
      status: overrideStatus ?? status,
      followups: followups
        .filter((f) => f.title.trim() !== "")
        .map((f) => ({
          id: f.id,
          title: f.title,
          assignee_profile_id: f.assignee_profile_id || null,
          assignee_company_id: f.assignee_company_id || null,
          due_offset_days: f.due_offset_days,
          notes: f.notes,
        })),
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
        const result = await saveDecision(payload)
        // Persist worked — *now* it's safe to advance the visible status.
        setStatus(payload.status)
        if (result.createdFollowups > 0) {
          toast.success(
            `Approved · ${result.createdFollowups} follow-up to-do${
              result.createdFollowups === 1 ? "" : "s"
            } created`
          )
        } else {
          toast.success(mode === "edit" ? "Saved" : "Created")
        }
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  function handleDelete() {
    if (!decision) return
    if (!confirm("Delete this decision and all its comments / files?")) return
    startTransition(async () => {
      try {
        await deleteDecision({ id: decision.id, project_id: data.project_id })
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
            <div className="flex items-center gap-2 mb-1">
              {decision && (
                <span className="text-xs font-mono text-muted">
                  #{decision.number}
                </span>
              )}
              <KindChip kind={kind} />
              <StatusBadge status={status} />
            </div>
            <DialogTitle>
              {mode === "edit" ? decision?.title : "New " + (kind === "change_order" ? "change order" : "selection")}
            </DialogTitle>
            <DialogDescription>
              {kind === "change_order"
                ? "Changes to scope or cost that need owner approval."
                : "Selections the owner needs to make (paint, fixtures, finishes)."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {canEdit && mode === "create" && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setKind("change_order")}
                className={cn(
                  "rounded-md border p-3 text-left cursor-pointer",
                  kind === "change_order"
                    ? "border-amber-500 bg-amber-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">Change order</div>
                <div className="text-xs text-muted">Scope or cost change</div>
              </button>
              <button
                onClick={() => setKind("selection")}
                className={cn(
                  "rounded-md border p-3 text-left cursor-pointer",
                  kind === "selection"
                    ? "border-blue-500 bg-blue-50"
                    : "border-border-strong"
                )}
              >
                <div className="font-medium text-sm">Selection</div>
                <div className="text-xs text-muted">Paint, fixtures, finishes</div>
              </button>
            </div>
          )}

          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canEdit}
              placeholder={kind === "change_order" ? "Move powder room wall" : "Master bath floor tile"}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={kind === "change_order" ? "Cost delta" : "Cost"}
              hint="Positive = adds to contract. Negative = credit."
            >
              <Input
                type="number"
                step="0.01"
                value={costDelta}
                onChange={(e) => setCostDelta(e.target.value)}
                disabled={!canEdit}
                placeholder="0.00"
              />
            </Field>
            <Field label="Cost preview">
              <div className="h-9 flex items-center font-mono text-sm">
                <CostDelta value={costDelta === "" ? null : Number(costDelta)} />
              </div>
            </Field>
          </div>
          <Field label="Description / scope">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              rows={4}
              placeholder="What's changing or being selected, and any relevant detail for the owner."
            />
          </Field>

          {/* Attachments */}
          <div>
            <Label>Photos &amp; files</Label>
            {canEdit && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => onPickFiles(e.target.files)}
              />
            )}
            <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {attachments.map((a, i) => (
                <AttachmentTile
                  key={a.storage_path}
                  att={a}
                  canEdit={canEdit}
                  onRemove={() =>
                    setAttachments(attachments.filter((_, idx) => idx !== i))
                  }
                  onCaption={(c) =>
                    setAttachments(
                      attachments.map((x, idx) =>
                        idx === i ? { ...x, caption: c } : x
                      )
                    )
                  }
                />
              ))}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="aspect-square rounded-md border border-dashed border-border-strong flex flex-col items-center justify-center text-muted hover:border-brand-500 hover:text-brand-600 cursor-pointer text-xs gap-1 disabled:opacity-50"
                >
                  <Upload className="h-5 w-5" />
                  {uploading ? "Uploading…" : "Add files"}
                </button>
              )}
            </div>
          </div>

          {/* Follow-ups (staff only) */}
          {canEdit && (
            <FollowupsEditor
              value={followups}
              onChange={setFollowups}
              profiles={data.profiles}
              companies={data.companies}
              alreadyApproved={status === "approved"}
            />
          )}

          {/* Comments */}
          <CommentsThread
            decisionId={decision?.id}
            projectId={data.project_id}
            comments={myComments}
            profiles={data.profiles}
            meName={data.me_name}
            canPost={!!decision && (canEdit || isClient)}
            isClient={isClient}
          />
        </DialogBody>
        {canEdit && (
          <DialogFooter>
            {mode === "edit" && decision && (
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
            {status !== "approved" && status !== "rejected" && (
              <>
                {status === "draft" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => saveWithStatus("pending_client")}
                    disabled={pending || uploading}
                  >
                    <Send className="h-4 w-4" /> Send to client
                  </Button>
                )}
                {status === "pending_client" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => saveWithStatus("rejected")}
                    disabled={pending || uploading}
                    className="text-danger"
                  >
                    Mark rejected
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => saveWithStatus("approved")}
                  disabled={pending || uploading}
                >
                  <Check className="h-4 w-4" />
                  Approve
                  {followups.length > 0
                    ? ` & create ${followups.length} to-do${
                        followups.length === 1 ? "" : "s"
                      }`
                    : ""}
                </Button>
              </>
            )}
            <Button
              type="button"
              variant={status === "approved" ? "secondary" : "primary"}
              onClick={() => handleSave()}
              disabled={pending || uploading}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FollowupsEditor({
  value,
  onChange,
  profiles,
  companies,
  alreadyApproved,
}: {
  value: Followup[]
  onChange: (v: Followup[]) => void
  profiles: DecisionsData["profiles"]
  companies: DecisionsData["companies"]
  alreadyApproved: boolean
}) {
  function add() {
    onChange([
      ...value,
      { title: "", due_offset_days: 7 },
    ])
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>
          <Sparkles className="inline h-3 w-3 mr-1 text-brand-500" />
          Follow-up to-dos
        </Label>
        {alreadyApproved && (
          <span className="text-xs text-muted">
            (already approved — new templates will be created on the schedule
            on the next save)
          </span>
        )}
      </div>
      <p className="text-xs text-muted mt-0.5">
        When this decision is approved, these to-dos will be auto-created on the
        Schedule, assigned to the chosen person.
      </p>
      {value.length > 0 && (
        <ul className="mt-2 space-y-2">
          {value.map((f, i) => (
            <li
              key={i}
              className="rounded-md border border-border p-2 grid grid-cols-1 sm:grid-cols-[1fr_180px_90px_auto] gap-2 items-center bg-background/50"
            >
              <Input
                value={f.title}
                onChange={(e) => {
                  const next = [...value]
                  next[i] = { ...f, title: e.target.value }
                  onChange(next)
                }}
                placeholder="E.g. Update plans / Issue PO"
              />
              <Select
                value={
                  f.assignee_profile_id
                    ? `p:${f.assignee_profile_id}`
                    : f.assignee_company_id
                    ? `c:${f.assignee_company_id}`
                    : ""
                }
                onChange={(e) => {
                  const v = e.target.value
                  const next = [...value]
                  if (v.startsWith("p:")) {
                    next[i] = {
                      ...f,
                      assignee_profile_id: v.slice(2),
                      assignee_company_id: null,
                    }
                  } else if (v.startsWith("c:")) {
                    next[i] = {
                      ...f,
                      assignee_profile_id: null,
                      assignee_company_id: v.slice(2),
                    }
                  } else {
                    next[i] = {
                      ...f,
                      assignee_profile_id: null,
                      assignee_company_id: null,
                    }
                  }
                  onChange(next)
                }}
              >
                <option value="">— Assign to —</option>
                <optgroup label="Staff">
                  {profiles
                    .filter((p) => p.role === "staff")
                    .map((p) => (
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
              <Input
                type="number"
                min={0}
                value={f.due_offset_days}
                onChange={(e) => {
                  const next = [...value]
                  next[i] = {
                    ...f,
                    due_offset_days: Math.max(0, Number(e.target.value) || 0),
                  }
                  onChange(next)
                }}
                title="Days after approval"
              />
              <button
                type="button"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                className="text-muted hover:text-danger p-1 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={add}
        className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
      >
        <Plus className="h-3 w-3" /> Add follow-up
      </button>
    </div>
  )
}

function CommentsThread({
  decisionId,
  projectId,
  comments,
  profiles,
  meName,
  canPost,
  isClient,
}: {
  decisionId?: string
  projectId: string
  comments: Tables<"decision_comments">[]
  profiles: DecisionsData["profiles"]
  meName: string
  canPost: boolean
  isClient: boolean
}) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!decisionId || !body.trim()) return
    startTransition(async () => {
      try {
        await postComment({
          decision_id: decisionId,
          project_id: projectId,
          body,
        })
        setBody("")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not post")
      }
    })
  }

  return (
    <div>
      <Label>
        <MessageSquare className="inline h-3 w-3 mr-1" />
        Comments
      </Label>
      <ul className="mt-2 space-y-2">
        {comments.length === 0 && (
          <li className="text-xs text-muted">No comments yet.</li>
        )}
        {comments.map((c) => {
          const author = profiles.find((p) => p.id === c.author_id)
          const name = author?.full_name || author?.email || "Someone"
          const isClientAuthor = author?.role === "client"
          return (
            <li
              key={c.id}
              className="flex items-start gap-2 rounded-md border border-border p-2 bg-background/30"
            >
              <Avatar name={name} size="sm" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{name}</span>
                  {isClientAuthor && (
                    <span className="text-[10px] text-blue-700 bg-blue-100 px-1 py-0.5 rounded">
                      client
                    </span>
                  )}
                  <span className="text-xs text-muted">
                    {formatDate(c.created_at)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap mt-0.5">{c.body}</p>
              </div>
            </li>
          )
        })}
      </ul>
      {canPost && (
        <div className="mt-3 flex gap-2 items-end">
          <Avatar name={meName} size="sm" />
          <div className="flex-1">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={isClient ? "Reply…" : "Reply to client / leave a note"}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={pending || !body.trim()}
          >
            Post
          </Button>
        </div>
      )}
      {!decisionId && (
        <p className="mt-2 text-xs text-muted">
          Comments are available after saving the decision.
        </p>
      )}
    </div>
  )
}

function AttachmentTile({
  att,
  canEdit,
  onRemove,
  onCaption,
}: {
  att: Attachment
  canEdit: boolean
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
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-0.5 opacity-0 group-hover:opacity-100 cursor-pointer"
          aria-label="Remove"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <Input
        value={att.caption ?? ""}
        onChange={(e) => onCaption(e.target.value)}
        placeholder="Caption"
        disabled={!canEdit}
        className="mt-1 text-[11px] h-7 px-2"
      />
    </div>
  )
}
