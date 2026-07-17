"use client"

import { useEffect, useState, useMemo, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  toastActionError,
  actionErrorMessage,
  isStaleDeploymentError,
} from "@/lib/action-error"
import {
  Upload,
  FileText,
  Map as MapIcon,
  ShieldCheck,
  ScrollText,
  File as FileIconLucide,
  Search,
  Image as ImageIcon,
  Trash2,
  Download,
  X,
  History,
  RefreshCcw,
  Eye,
  EyeOff,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Receipt,
  UploadCloud,
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
import { uploadToStorage } from "@/lib/storage/upload"
import {
  saveProjectFile,
  deleteProjectFile,
  setProjectFileArchived,
  setProjectFileClientVisibility,
  getFileVersions,
  setMediaTags,
  type FileInputT,
} from "@/app/actions/files"
import type { Tables, Enums } from "@/lib/db/types"
import type { UserRole } from "@/lib/auth"

type Media = {
  id: string
  source_id: string
  storage_path: string
  file_name: string
  file_type: string | null
  caption: string | null
  source: "plan" | "daily-log" | "decision"
  source_label: string
  source_date: string
  tags: string[]
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
  plot_plan: { label: "Plot plan", icon: MapIcon, tone: "info" },
  permit: { label: "Permit", icon: ShieldCheck, tone: "success" },
  contract: { label: "Contract", icon: ScrollText, tone: "warning" },
  quotes: { label: "Quotes", icon: Receipt, tone: "info" },
  other: { label: "Other", icon: FileIconLucide, tone: "muted" },
}

type PlanSort = "newest" | "title" | "category"

export function FilesClient({ data }: { data: FilesData }) {
  const canEdit = data.role === "staff"
  const [uploadOpen, setUploadOpen] = useState(false)
  // Files dropped anywhere on the page — preloaded into the upload dialog.
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null)
  // Counter, not boolean: dragenter/dragleave fire per child element crossed.
  const [dragDepth, setDragDepth] = useState(0)
  // When non-null, the upload dialog opens pre-targeted as a revision of the
  // referenced file (parent_file_id chain handled server-side).
  const [revisionTarget, setRevisionTarget] = useState<{
    id: string
    title: string
    category: Enums<"file_category">
    client_visible: boolean
  } | null>(null)
  // When set, render the History dialog for the given plan's chain.
  const [historyTarget, setHistoryTarget] = useState<Tables<"project_files"> | null>(
    null
  )
  const [search, setSearch] = useState("")
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  // Plans list controls: free-text search, category chip, sort order.
  const [planQuery, setPlanQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<
    Enums<"file_category"> | null
  >(null)
  const [planSort, setPlanSort] = useState<PlanSort>("newest")
  const [lightbox, setLightbox] = useState<Media | null>(null)
  // When set, render the in-browser document viewer for this plan.
  const [viewerTarget, setViewerTarget] = useState<Tables<"project_files"> | null>(
    null
  )
  const [showArchived, setShowArchived] = useState(false)

  // Split plans into the active list and the archived folder. Archived plans
  // are filed away (still downloadable) but kept out of the main list.
  const activePlans = useMemo(() => {
    const q = planQuery.trim().toLowerCase()
    const filtered = data.plans
      .filter((p) => !p.archived_at)
      .filter((p) => !categoryFilter || p.category === categoryFilter)
      .filter(
        (p) =>
          !q ||
          p.title.toLowerCase().includes(q) ||
          p.file_name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q)
      )
    return [...filtered].sort((a, b) => {
      switch (planSort) {
        case "title":
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
        case "category":
          return (
            CATEGORY_META[a.category].label.localeCompare(
              CATEGORY_META[b.category].label
            ) || a.title.localeCompare(b.title)
          )
        default:
          return b.created_at.localeCompare(a.created_at)
      }
    })
  }, [data.plans, planQuery, categoryFilter, planSort])
  const archivedPlans = useMemo(
    () => data.plans.filter((p) => p.archived_at),
    [data.plans]
  )
  // Chip row shows only categories that exist on this job (with counts).
  const categoryCounts = useMemo(() => {
    const m = new Map<Enums<"file_category">, number>()
    for (const p of data.plans) {
      if (p.archived_at) continue
      m.set(p.category, (m.get(p.category) ?? 0) + 1)
    }
    return m
  }, [data.plans])

  // Global tag pool for the filter chip row. Built from every visible
  // media tag (not just the currently-filtered set) so the user can pivot
  // by clicking through.
  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const m of data.media) for (const t of m.tags) s.add(t)
    return Array.from(s).sort()
  }, [data.media])

  const filteredMedia = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data.media
      .filter((m) => m.file_type?.startsWith("image/") || m.file_type?.startsWith("video/"))
      .filter((m) => !tagFilter || m.tags.includes(tagFilter))
      .filter((m) => {
        if (!q) return true
        return (
          m.file_name.toLowerCase().includes(q) ||
          (m.caption ?? "").toLowerCase().includes(q) ||
          m.source_label.toLowerCase().includes(q) ||
          m.tags.some((t) => t.includes(q))
        )
      })
      .sort((a, b) => b.source_date.localeCompare(a.source_date))
  }, [data.media, search, tagFilter])

  // Page-wide drag & drop (staff only): dropping files anywhere opens the
  // upload dialog preloaded with them.
  function onDragEnter(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth((d) => d + 1)
  }
  function onDragOver(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
  }
  function onDragLeave(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth((d) => Math.max(0, d - 1))
  }
  function onDrop(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth(0)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    setDroppedFiles(files)
    setUploadOpen(true)
  }

  const hasPlanFilters = planQuery.trim() !== "" || categoryFilter !== null

  return (
    <div
      className="relative max-w-7xl mx-auto px-4 md:px-6 py-5 space-y-8"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-brand-500 bg-brand-50/80">
          <div className="flex flex-col items-center gap-2 text-brand-700">
            <UploadCloud className="h-10 w-10" />
            <p className="text-sm font-medium">Drop files to upload</p>
          </div>
        </div>
      )}
      {/* Plans section */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-base font-semibold">Plans &amp; documents</h2>
            <p className="text-xs text-muted">
              House plans, plot plans, permits, contracts, and quotes.
              {canEdit ? " Drag files anywhere on this page to upload." : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
              <Input
                value={planQuery}
                onChange={(e) => setPlanQuery(e.target.value)}
                placeholder="Search documents…"
                className="pl-8 w-44 sm:w-52"
              />
            </div>
            <Select
              value={planSort}
              onChange={(e) => setPlanSort(e.target.value as PlanSort)}
              className="w-auto h-8 text-xs"
              aria-label="Sort documents"
            >
              <option value="newest">Newest first</option>
              <option value="title">Title A–Z</option>
              <option value="category">By type</option>
            </Select>
            {canEdit && (
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <Upload className="h-3.5 w-3.5" /> Upload
              </Button>
            )}
          </div>
        </div>

        {categoryCounts.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted mr-1">
              Type
            </span>
            {(Object.keys(CATEGORY_META) as Enums<"file_category">[])
              .filter((c) => categoryCounts.has(c))
              .map((c) => {
                const active = categoryFilter === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter(active ? null : c)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] cursor-pointer transition-colors",
                      active
                        ? "bg-brand-500 text-white"
                        : "bg-surface text-muted border border-border-strong hover:text-foreground hover:bg-background"
                    )}
                  >
                    {CATEGORY_META[c].label}
                    <span className={active ? "opacity-80" : "opacity-60"}>
                      {categoryCounts.get(c)}
                    </span>
                  </button>
                )
              })}
            {categoryFilter && (
              <button
                type="button"
                onClick={() => setCategoryFilter(null)}
                className="text-[11px] text-muted hover:text-foreground underline cursor-pointer"
              >
                clear
              </button>
            )}
          </div>
        )}

        {activePlans.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title={
              hasPlanFilters
                ? "No matches"
                : archivedPlans.length > 0
                  ? "No active plans"
                  : "No plans uploaded"
            }
            description={
              hasPlanFilters
                ? "Try different search terms or clear the type filter."
                : canEdit
                  ? "Upload the house plans, plot plan, permits, contract, and quotes here."
                  : "No documents yet."
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activePlans.map((p) => (
              <PlanCard
                key={p.id}
                file={p}
                url={data.signed_urls[p.storage_path]}
                canEdit={canEdit}
                projectId={data.project_id}
                onView={() => setViewerTarget(p)}
                onReplace={() =>
                  setRevisionTarget({
                    id: p.id,
                    title: p.title,
                    category: p.category,
                    client_visible: p.client_visible,
                  })
                }
                onShowHistory={() => setHistoryTarget(p)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Archived folder */}
      {archivedPlans.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-semibold cursor-pointer hover:text-brand-600"
          >
            {showArchived ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <Archive className="h-4 w-4 text-muted" />
            Archived
            <span className="text-xs font-normal text-muted">
              ({archivedPlans.length})
            </span>
          </button>
          {showArchived && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {archivedPlans.map((p) => (
                <PlanCard
                  key={p.id}
                  file={p}
                  url={data.signed_urls[p.storage_path]}
                  canEdit={canEdit}
                  projectId={data.project_id}
                  archived
                  onView={() => setViewerTarget(p)}
                  onShowHistory={() => setHistoryTarget(p)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Gallery section */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-base font-semibold">Project gallery</h2>
            <p className="text-xs text-muted">
              All photos and videos from job logs. Search by name, caption, or
              date.
            </p>
          </div>
          <div className="flex items-center gap-2">
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

        {allTags.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted mr-1">
              Tag
            </span>
            {allTags.map((t) => {
              const active = tagFilter === t
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTagFilter(active ? null : t)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] cursor-pointer transition-colors",
                    active
                      ? "bg-brand-500 text-white"
                      : "bg-surface text-muted border border-border-strong hover:text-foreground hover:bg-background"
                  )}
                >
                  {t}
                </button>
              )
            })}
            {tagFilter && (
              <button
                type="button"
                onClick={() => setTagFilter(null)}
                className="text-[11px] text-muted hover:text-foreground underline cursor-pointer"
              >
                clear
              </button>
            )}
          </div>
        )}

        {filteredMedia.length === 0 ? (
          <EmptyState
            icon={<ImageIcon className="h-8 w-8" />}
            title={search ? "No matches" : "No media yet"}
            description={
              search
                ? "Try different search terms."
                : "Photos added to job logs will appear in this gallery."
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
                  {/* Hover-reveal is meaningless on touch — keep the caption
                      strip visible on phones. */}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] p-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
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
          onClose={() => {
            setUploadOpen(false)
            setDroppedFiles(null)
          }}
          projectId={data.project_id}
          initialFiles={droppedFiles}
        />
      )}
      {revisionTarget && canEdit && (
        <UploadDialog
          open={true}
          onClose={() => setRevisionTarget(null)}
          projectId={data.project_id}
          revisionOf={revisionTarget}
        />
      )}
      {historyTarget && (
        <HistoryDialog
          file={historyTarget}
          projectId={data.project_id}
          onClose={() => setHistoryTarget(null)}
        />
      )}
      {lightbox && (
        <Lightbox
          media={lightbox}
          url={data.signed_urls[lightbox.storage_path]}
          canEdit={canEdit}
          projectId={data.project_id}
          suggestions={allTags}
          onClose={() => setLightbox(null)}
        />
      )}
      {viewerTarget && (
        <DocViewer
          file={viewerTarget}
          url={data.signed_urls[viewerTarget.storage_path]}
          onClose={() => setViewerTarget(null)}
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
  archived = false,
  onView,
  onReplace,
  onShowHistory,
}: {
  file: Tables<"project_files">
  url: string | undefined
  canEdit: boolean
  projectId: string
  archived?: boolean
  onView: () => void
  onReplace?: () => void
  onShowHistory: () => void
}) {
  const meta = CATEGORY_META[file.category]
  const Icon = meta.icon
  const isImage = file.file_type?.startsWith("image/") ?? false
  const isPdf =
    file.file_type === "application/pdf" ||
    file.file_name.toLowerCase().endsWith(".pdf")
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const hasHistory = file.version > 1 || file.parent_file_id != null

  function handleDelete() {
    if (
      !confirm(
        hasHistory
          ? `Delete "${file.title}" v${file.version}? The previous revision will be promoted to current.`
          : `Delete "${file.title}"?`
      )
    )
      return
    startTransition(async () => {
      try {
        await deleteProjectFile({ id: file.id, project_id: projectId })
        toast.success("Deleted")
        router.refresh()
      } catch (e) {
        toastActionError(e, "Delete failed")
      }
    })
  }

  function handleArchive(next: boolean) {
    startTransition(async () => {
      try {
        await setProjectFileArchived({
          id: file.id,
          project_id: projectId,
          archived: next,
        })
        toast.success(next ? "Archived" : "Restored")
        router.refresh()
      } catch (e) {
        toastActionError(e, "Action failed")
      }
    })
  }

  function handleVisibility(next: boolean) {
    startTransition(async () => {
      try {
        await setProjectFileClientVisibility({
          id: file.id,
          project_id: projectId,
          visible: next,
        })
        toast.success(next ? "Visible to client" : "Hidden from client")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed")
      }
    })
  }

  return (
    <Card className={cn("flex flex-col", archived && "opacity-75")}>
      {/* Thumbnail: images render directly; PDFs get a live first-page
          preview via the browser's built-in reader (lazy, pointer-events
          off — the overlay button owns the click); everything else keeps
          the category icon. A div (not a button) so the PDF iframe stays
          valid markup. */}
      <div className="aspect-[4/3] bg-background flex items-center justify-center overflow-hidden relative group">
        {isImage && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={file.title}
            className="h-full w-full object-cover"
          />
        ) : isPdf && url ? (
          <iframe
            src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
            title={`Preview of ${file.title}`}
            className="h-full w-full pointer-events-none"
            loading="lazy"
            tabIndex={-1}
            aria-hidden
          />
        ) : (
          <Icon className="h-12 w-12 text-muted" />
        )}
        <button
          type="button"
          onClick={onView}
          className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center cursor-pointer"
          title="View"
          aria-label={`View ${file.title}`}
        >
          <Eye className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        {file.version > 1 && (
          <span className="pointer-events-none absolute top-2 left-2 inline-flex items-center rounded-full bg-foreground/80 text-white text-[10px] font-medium px-1.5 py-0.5">
            v{file.version}
          </span>
        )}
      </div>
      <CardBody className="flex-1 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {canEdit && file.client_visible && (
              <Badge tone="success">Client</Badge>
            )}
          </span>
          <div className="flex items-center gap-1">
            {canEdit && (
              <button
                type="button"
                onClick={() => handleVisibility(!file.client_visible)}
                disabled={pending}
                className={cn(
                  "p-1 cursor-pointer inline-flex",
                  file.client_visible
                    ? "text-brand-600 hover:text-foreground"
                    : "text-muted hover:text-foreground"
                )}
                title={
                  file.client_visible
                    ? "Visible to the client — click to hide"
                    : "Hidden from the client — click to share"
                }
                aria-label={
                  file.client_visible ? "Hide from client" : "Show to client"
                }
              >
                {file.client_visible ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {/* Revision history is a staff action (getFileVersions is
                staff-gated) — clients used to get a dead icon here. */}
            {hasHistory && canEdit && (
              <button
                type="button"
                onClick={onShowHistory}
                className="text-muted hover:text-foreground p-1 cursor-pointer inline-flex"
                title="View revision history"
                aria-label="View revision history"
              >
                <History className="h-3.5 w-3.5" />
              </button>
            )}
            {canEdit && !archived && onReplace && (
              <button
                type="button"
                onClick={onReplace}
                className="text-muted hover:text-foreground p-1 cursor-pointer inline-flex"
                title="Upload a new revision"
                aria-label="Upload a new revision"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
              </button>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-foreground p-1 inline-flex"
                title="Download"
                aria-label="Download"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => handleArchive(!archived)}
                disabled={pending}
                className="text-muted hover:text-foreground p-1 cursor-pointer inline-flex"
                title={archived ? "Restore" : "Archive"}
                aria-label={archived ? "Restore" : "Archive"}
              >
                {archived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
              </button>
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

// In-browser viewer for plans & documents. PDFs render in an iframe (the
// browser's built-in PDF reader), images inline; anything the browser can't
// display natively (e.g. Office docs) falls back to a download prompt.
function DocViewer({
  file,
  url,
  onClose,
}: {
  file: Tables<"project_files">
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

  const name = (file.file_name ?? "").toLowerCase()
  const isPdf = file.file_type === "application/pdf" || name.endsWith(".pdf")
  const isImage = file.file_type?.startsWith("image/") ?? false
  const isVideo = file.file_type?.startsWith("video/") ?? false

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex flex-col p-4"
      onClick={onClose}
    >
      <div
        className="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden rounded-lg bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{file.title}</div>
            <div className="truncate text-xs text-muted">{file.file_name}</div>
          </div>
          <div className="flex items-center gap-1">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-foreground p-1.5 inline-flex"
                title="Download"
                aria-label="Download"
              >
                <Download className="h-4 w-4" />
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-foreground p-1.5 cursor-pointer"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-background">
          {!url ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Loading…
            </div>
          ) : isPdf ? (
            <iframe
              src={url}
              title={file.title}
              className="h-full w-full border-0"
            />
          ) : isImage ? (
            <div className="flex h-full items-center justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={file.title}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : isVideo ? (
            <div className="flex h-full items-center justify-center p-4">
              <video src={url} controls className="max-h-full max-w-full" />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <FileIconLucide className="h-10 w-10 text-muted" />
              <p className="text-sm text-muted">
                This file type can&apos;t be previewed in the browser.
              </p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline"
              >
                <Download className="h-4 w-4" /> Download to open
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryDialog({
  file,
  projectId,
  onClose,
}: {
  file: Tables<"project_files">
  projectId: string
  onClose: () => void
}) {
  const [versions, setVersions] = useState<
    Awaited<ReturnType<typeof getFileVersions>> | null
  >(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getFileVersions({ project_id: projectId, file_id: file.id })
      .then((rows) => {
        if (alive) setVersions(rows)
      })
      .catch((e) => {
        if (alive) setError(actionErrorMessage(e, "Lookup failed"))
      })
    return () => {
      alive = false
    }
  }, [file.id, projectId])

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{file.title} — history</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : !versions ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-muted">No history yet.</p>
          ) : (
            <ul className="space-y-2">
              {versions
                .slice()
                .reverse()
                .map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        v{v.version} · {v.file_name}
                        {v.is_current && (
                          <span className="ml-2 text-[11px] text-success">
                            current
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {formatDate(v.created_at)}
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadDialog({
  open,
  onClose,
  projectId,
  revisionOf,
  initialFiles,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  // When set, the upload is treated as a new revision of this file:
  // category + title + visibility pre-fill from it, and the saveProjectFile
  // call carries replaces_id so the server links the chain. Revisions are
  // single-file by nature; fresh uploads accept a batch.
  revisionOf?: {
    id: string
    title: string
    category: Enums<"file_category">
    client_visible: boolean
  }
  // Files dropped onto the page — adopted as the initial batch.
  initialFiles?: File[] | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState("")
  const [category, setCategory] = useState<Enums<"file_category">>(
    revisionOf?.category ?? "house_plans"
  )
  const [title, setTitle] = useState(
    revisionOf?.title ??
      (initialFiles?.length === 1
        ? initialFiles[0].name.replace(/\.[a-z0-9]{2,5}$/i, "")
        : "")
  )
  const [description, setDescription] = useState("")
  const [clientVisible, setClientVisible] = useState(
    revisionOf?.client_visible ?? true
  )
  // Generated ids keep React keys stable even for same-name files.
  const [files, setFiles] = useState<{ id: string; file: File }[]>(() =>
    (initialFiles ?? []).map((file) => ({ id: crypto.randomUUID(), file }))
  )
  const fileRef = useRef<HTMLInputElement>(null)

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return
    const adds = Array.from(picked).map((file) => ({
      id: crypto.randomUUID(),
      file,
    }))
    // Revisions replace exactly one file; batches append.
    setFiles((prev) => {
      const next = revisionOf ? adds.slice(0, 1) : [...prev, ...adds]
      // A lone file names itself so drag-drop is one click to submit.
      if (!revisionOf && next.length === 1) {
        setTitle((t) => t || next[0].file.name.replace(/\.[a-z0-9]{2,5}$/i, ""))
      }
      return next
    })
    if (fileRef.current) fileRef.current.value = ""
  }

  async function handleSubmit() {
    if (files.length === 0) {
      toast.error("Pick at least one file")
      return
    }
    // Single file (or revision): the Title field names it. A multi-file
    // batch titles each row by its file name.
    if (files.length === 1 && !title.trim()) {
      toast.error("Title is required")
      return
    }
    setUploading(true)
    try {
      const supabase = createSupabaseBrowserClient()
      let uploaded = 0
      for (let i = 0; i < files.length; i++) {
        const file = files[i].file
        setProgress(
          files.length > 1
            ? `Uploading ${i + 1} of ${files.length} — ${file.name}`
            : "Uploading…"
        )
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin"
        const path = `projects/${projectId}/plans/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.${ext}`
        const result = await uploadToStorage(supabase, {
          bucket: "project-files",
          path,
          body: file,
          contentType: file.type || undefined,
        })
        if (!result.ok) {
          toast.error(`${file.name}: ${result.error}`)
          continue
        }
        const payload: FileInputT = {
          project_id: projectId,
          category,
          title:
            files.length === 1
              ? title.trim()
              : file.name.replace(/\.[a-z0-9]{2,5}$/i, ""),
          description: description || null,
          storage_path: path,
          file_name: file.name,
          file_type: file.type || null,
          file_size: file.size,
          client_visible: clientVisible,
          replaces_id: revisionOf?.id,
        }
        try {
          await saveProjectFile(payload)
          uploaded++
        } catch (e) {
          // Stale-deployment failures get the refresh-prompt toast; real
          // save errors keep the per-file prefix so a batch names its
          // casualties.
          if (isStaleDeploymentError(e)) {
            toastActionError(e, "Save failed")
          } else {
            toast.error(
              `${file.name}: ${e instanceof Error ? e.message : "Save failed"}`
            )
          }
        }
      }
      if (uploaded > 0) {
        toast.success(
          uploaded === 1 ? "Uploaded" : `${uploaded} files uploaded`
        )
        startTransition(() => {
          router.refresh()
        })
        onClose()
      }
    } finally {
      setUploading(false)
      setProgress("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {revisionOf ? `Replace "${revisionOf.title}"` : "Upload files"}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Category">
            <Select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as Enums<"file_category">)
              }
            >
              {(Object.keys(CATEGORY_META) as Enums<"file_category">[]).map(
                (c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                )
              )}
            </Select>
          </Field>
          {files.length <= 1 && (
            <Field label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="House plans — rev C"
              />
            </Field>
          )}
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </Field>
          <Field label={revisionOf ? "File" : "Files"}>
            <input
              ref={fileRef}
              type="file"
              multiple={!revisionOf}
              onChange={(e) => addFiles(e.target.files)}
              className="text-sm"
            />
            {files.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <span className="truncate">
                      {f.file.name} · {(f.file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                    <button
                      type="button"
                      className="text-muted hover:text-danger cursor-pointer"
                      onClick={() =>
                        setFiles((prev) => prev.filter((x) => x.id !== f.id))
                      }
                      disabled={uploading}
                      aria-label={`Remove ${f.file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files.length > 1 && (
              <p className="text-xs text-muted mt-1">
                Each file is titled by its name; category, description, and
                visibility apply to the whole batch.
              </p>
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={clientVisible}
              onChange={(e) => setClientVisible(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border-strong"
            />
            <span>
              <span className="font-medium">Visible to client</span>
              <span className="block text-xs text-muted">
                Uncheck to keep this off the homeowner&rsquo;s portal — you can
                flip it later with the eye icon on the card.
              </span>
            </span>
          </label>
          {uploading && progress && (
            <p className="text-xs text-muted">{progress}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={
              pending ||
              uploading ||
              files.length === 0 ||
              (files.length === 1 && !title.trim())
            }
          >
            {uploading
              ? "Uploading…"
              : files.length > 1
                ? `Upload ${files.length} files`
                : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Lightbox({
  media,
  url,
  canEdit,
  projectId,
  suggestions,
  onClose,
}: {
  media: Media
  url: string | undefined
  canEdit: boolean
  projectId: string
  suggestions: string[]
  onClose: () => void
}) {
  const router = useRouter()
  const [tags, setTags] = useState<string[]>(media.tags)
  const [draft, setDraft] = useState("")
  const [saving, startSaving] = useTransition()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Map our gallery's source string to the action's source enum.
  const actionSource =
    media.source === "plan"
      ? "project_file"
      : media.source === "daily-log"
        ? "daily_log_attachment"
        : "decision_attachment"

  function commitTags(next: string[]) {
    setTags(next)
    startSaving(async () => {
      try {
        await setMediaTags({
          project_id: projectId,
          source: actionSource,
          id: media.source_id,
          tags: next,
        })
        // Keep parent state in sync so the gallery row + filter chips refresh.
        router.refresh()
      } catch (e) {
        toastActionError(e, "Tag save failed")
        // Roll back the optimistic update so chips revert.
        setTags(media.tags)
      }
    })
  }

  function addTag(t: string) {
    const v = t.trim().toLowerCase()
    if (!v || v.length > 40) return
    if (tags.includes(v)) {
      setDraft("")
      return
    }
    commitTags([...tags, v].sort())
    setDraft("")
  }

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
        className="max-w-5xl max-h-[90vh] w-full flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          media.file_type?.startsWith("video/") ? (
            <video
              src={url}
              controls
              className="max-h-[70vh] max-w-full rounded-md"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={media.caption ?? media.file_name}
              className="max-h-[70vh] max-w-full rounded-md object-contain"
            />
          )
        ) : (
          <div className="text-white">Loading…</div>
        )}
        <div className="mt-3 text-center text-white">
          <div className="font-medium">{media.caption ?? media.file_name}</div>
          <div className="text-sm text-white/70">{media.source_label}</div>
        </div>

        {/* Tag editor — staff can add/remove; everyone else sees read-only chips */}
        <div className="mt-3 w-full max-w-2xl flex flex-col gap-2 items-center">
          {(tags.length > 0 || canEdit) && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-white/10 text-white text-xs px-2 py-0.5"
                >
                  {t}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => commitTags(tags.filter((x) => x !== t))}
                      aria-label={`Remove ${t}`}
                      className="text-white/70 hover:text-white cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault()
                      addTag(draft)
                    }
                    if (
                      e.key === "Backspace" &&
                      draft === "" &&
                      tags.length > 0
                    ) {
                      commitTags(tags.slice(0, -1))
                    }
                  }}
                  onBlur={() => {
                    if (draft.trim() !== "") addTag(draft)
                  }}
                  placeholder={
                    tags.length === 0 ? "Add tag…" : ""
                  }
                  disabled={saving}
                  className="bg-transparent border-b border-white/30 text-white text-xs placeholder:text-white/40 outline-none w-24"
                />
              )}
            </div>
          )}
          {canEdit && suggestions.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1">
              {suggestions
                .filter((s) => !tags.includes(s))
                .slice(0, 8)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => addTag(s)}
                    disabled={saving}
                    className="text-[11px] text-white/60 hover:text-white border border-white/20 rounded-full px-2 py-0.5 cursor-pointer"
                  >
                    + {s}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Keep small classname helper local since we already import cn elsewhere
void cn
