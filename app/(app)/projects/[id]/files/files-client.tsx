"use client"

import { useEffect, useState, useMemo, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Upload,
  FileText,
  Map,
  ShieldCheck,
  ScrollText,
  File as FileIconLucide,
  Search,
  Image as ImageIcon,
  Trash2,
  Download,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardBody } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn, formatDate } from "@/lib/utils"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  saveProjectFile,
  deleteProjectFile,
  type FileInputT,
} from "@/app/actions/files"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"

type Media = {
  id: string
  storage_path: string
  file_name: string
  file_type: string | null
  caption: string | null
  source: "plan" | "daily-log" | "decision"
  source_label: string
  source_date: string
}

export type FilesData = {
  project_id: string
  role: UserRole
  plans: Tables<"project_files">[]
  media: Media[]
  signed_urls: Record<string, string>
}

const CATEGORY_META: Record<
  Enums<"file_category">,
  { label: string; icon: typeof FileText; tone: "brand" | "info" | "success" | "warning" | "muted" }
> = {
  house_plans: { label: "House plans", icon: FileText, tone: "brand" },
  plot_plan: { label: "Plot plan", icon: Map, tone: "info" },
  permit: { label: "Permit", icon: ShieldCheck, tone: "success" },
  contract: { label: "Contract", icon: ScrollText, tone: "warning" },
  other: { label: "Other", icon: FileIconLucide, tone: "muted" },
}

export function FilesClient({ data }: { data: FilesData }) {
  const canEdit = data.role === "staff"
  const [uploadOpen, setUploadOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "plan" | "daily-log" | "decision"
  >("all")
  const [lightbox, setLightbox] = useState<Media | null>(null)

  const filteredMedia = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data.media
      .filter((m) => m.file_type?.startsWith("image/") || m.file_type?.startsWith("video/"))
      .filter((m) => sourceFilter === "all" || m.source === sourceFilter)
      .filter((m) => {
        if (!q) return true
        return (
          m.file_name.toLowerCase().includes(q) ||
          (m.caption ?? "").toLowerCase().includes(q) ||
          m.source_label.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => b.source_date.localeCompare(a.source_date))
  }, [data.media, search, sourceFilter])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5 space-y-8">
      {/* Plans section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">Plans &amp; documents</h2>
            <p className="text-xs text-muted">
              House plans, plot plans, permits, and contracts.
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Upload
            </Button>
          )}
        </div>

        {data.plans.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title="No plans uploaded"
            description={
              canEdit
                ? "Upload the house plans, plot plan, permits, and contract here."
                : "No documents yet."
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.plans.map((p) => (
              <PlanCard
                key={p.id}
                file={p}
                url={data.signed_urls[p.storage_path]}
                canEdit={canEdit}
                projectId={data.project_id}
              />
            ))}
          </div>
        )}
      </section>

      {/* Gallery section */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-base font-semibold">Project gallery</h2>
            <p className="text-xs text-muted">
              All photos and videos from daily logs, decisions, and uploaded plans.
              Search by name, caption, or source.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={sourceFilter}
              onChange={(e) =>
                setSourceFilter(e.target.value as typeof sourceFilter)
              }
              className="w-auto"
            >
              <option value="all">All sources</option>
              <option value="daily-log">Daily logs</option>
              <option value="decision">Decisions</option>
              <option value="plan">Plans &amp; docs</option>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="pl-8 w-56"
              />
            </div>
          </div>
        </div>

        {filteredMedia.length === 0 ? (
          <EmptyState
            icon={<ImageIcon className="h-8 w-8" />}
            title={search ? "No matches" : "No media yet"}
            description={
              search
                ? "Try different search terms or change the source filter."
                : "Photos uploaded to daily logs, decisions, or here will appear in this gallery."
            }
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {filteredMedia.map((m) => {
              const url = data.signed_urls[m.storage_path]
              const isVideo = m.file_type?.startsWith("video/")
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setLightbox(m)}
                  className="group relative aspect-square rounded-md overflow-hidden border border-border bg-background cursor-pointer hover:border-brand-500"
                >
                  {url && !isVideo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt={m.caption ?? m.file_name}
                      className="h-full w-full object-cover"
                    />
                  ) : isVideo && url ? (
                    <video
                      src={url}
                      className="h-full w-full object-cover"
                      muted
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-muted">
                      <FileIconLucide className="h-6 w-6" />
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] p-1.5 opacity-0 group-hover:opacity-100">
                    <div className="font-medium truncate">
                      {m.caption ?? m.file_name}
                    </div>
                    <div className="opacity-80 truncate">{m.source_label}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {uploadOpen && canEdit && (
        <UploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          projectId={data.project_id}
        />
      )}
      {lightbox && (
        <Lightbox
          media={lightbox}
          url={data.signed_urls[lightbox.storage_path]}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

function PlanCard({
  file,
  url,
  canEdit,
  projectId,
}: {
  file: Tables<"project_files">
  url: string | undefined
  canEdit: boolean
  projectId: string
}) {
  const meta = CATEGORY_META[file.category]
  const Icon = meta.icon
  const isImage = file.file_type?.startsWith("image/") ?? false
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function handleDelete() {
    if (!confirm(`Delete "${file.title}"?`)) return
    startTransition(async () => {
      try {
        await deleteProjectFile({ id: file.id, project_id: projectId })
        toast.success("Deleted")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <Card className="flex flex-col">
      <div className="aspect-[4/3] bg-background flex items-center justify-center overflow-hidden">
        {isImage && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={file.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon className="h-12 w-12 text-muted" />
        )}
      </div>
      <CardBody className="flex-1 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <div className="flex items-center gap-1">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-foreground p-1 inline-flex"
                title="Open"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={pending}
                className="text-muted hover:text-danger p-1 cursor-pointer"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="font-medium text-sm">{file.title}</div>
        {file.description && (
          <p className="text-xs text-muted line-clamp-2">{file.description}</p>
        )}
        <p className="text-xs text-muted mt-auto">
          {file.file_name} · {formatDate(file.created_at)}
        </p>
      </CardBody>
    </Card>
  )
}

function UploadDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean
  onClose: () => void
  projectId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [category, setCategory] = useState<Enums<"file_category">>("house_plans")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleSubmit() {
    if (!file) {
      toast.error("Pick a file")
      return
    }
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
      const path = `projects/${projectId}/plans/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`
      const { error: upErr } = await supabase.storage
        .from("project-files")
        .upload(path, file, { contentType: file.type || undefined })
      if (upErr) throw upErr

      const payload: FileInputT = {
        project_id: projectId,
        category,
        title: title.trim(),
        description: description || null,
        storage_path: path,
        file_name: file.name,
        file_type: file.type || null,
        file_size: file.size,
      }
      startTransition(async () => {
        try {
          await saveProjectFile(payload)
          toast.success("Uploaded")
          router.refresh()
          onClose()
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Save failed")
        }
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Upload file</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Category">
            <Select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as Enums<"file_category">)
              }
            >
              <option value="house_plans">House plans</option>
              <option value="plot_plan">Plot plan</option>
              <option value="permit">Permit</option>
              <option value="contract">Contract</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="House plans — rev C"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </Field>
          <Field label="File">
            <input
              ref={fileRef}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
            {file && (
              <p className="text-xs text-muted mt-1">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={pending || uploading || !file || !title.trim()}
          >
            {uploading ? "Uploading…" : pending ? "Saving…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Lightbox({
  media,
  url,
  onClose,
}: {
  media: Media
  url: string | undefined
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute top-4 right-4 text-white p-2 rounded-md hover:bg-white/10 cursor-pointer"
        onClick={onClose}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="max-w-5xl max-h-[90vh] flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          media.file_type?.startsWith("video/") ? (
            <video
              src={url}
              controls
              className="max-h-[80vh] max-w-full rounded-md"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={media.caption ?? media.file_name}
              className="max-h-[80vh] max-w-full rounded-md object-contain"
            />
          )
        ) : (
          <div className="text-white">Loading…</div>
        )}
        <div className="mt-3 text-center text-white">
          <div className="font-medium">{media.caption ?? media.file_name}</div>
          <div className="text-sm text-white/70">{media.source_label}</div>
        </div>
      </div>
    </div>
  )
}

// Keep small classname helper local since we already import cn elsewhere
void cn
