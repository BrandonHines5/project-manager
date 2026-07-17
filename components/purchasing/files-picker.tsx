"use client"

import { useMemo, useState } from "react"
import { Check, FileIcon, X } from "lucide-react"
import { Input, Label } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

// The slice of a project_files row the bid/PO drawers need to link a
// Files-tab document as an attachment (no re-upload — the blob stays owned
// by project_files).
export type PurchasingFileOption = {
  id: string
  title: string
  category: Enums<"file_category">
  file_name: string
  file_type: string | null
  file_size: number | null
  storage_path: string
}

const CATEGORY_LABEL: Record<Enums<"file_category">, string> = {
  house_plans: "House plans",
  plot_plan: "Plot plan",
  permit: "Permit",
  contract: "Contract",
  quotes: "Quotes",
  other: "Other",
}

/**
 * Inline "Link from Files" panel (not a nested Dialog — the drawers avoid
 * dueling focus traps, see CopyBidFooter). Lists the project's current
 * Files-tab documents; picking one adds it as a linked attachment.
 */
export function FilesLinkPanel({
  files,
  linkedIds,
  onPick,
  onClose,
}: {
  files: PurchasingFileOption[]
  // project_file ids already attached — shown checked and unclickable.
  linkedIds: Set<string>
  onPick: (file: PurchasingFileOption) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files
    return files.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        f.file_name.toLowerCase().includes(q) ||
        CATEGORY_LABEL[f.category].toLowerCase().includes(q)
    )
  }, [files, query])

  return (
    <div className="mt-2 rounded-md border border-border-strong bg-background/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Link from Files</Label>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-foreground p-1 cursor-pointer"
          aria-label="Close file picker"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-[11px] text-muted">
        The document stays in the Files tab — no duplicate upload. Anything you
        link here becomes visible to the subs this goes out to.
      </p>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search files…"
      />
      {files.length === 0 ? (
        <p className="text-xs text-muted">
          No documents in the Files tab yet — upload plans there first, or use
          Add files for a one-off attachment.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted">No files match “{query}”.</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto space-y-1">
          {visible.map((f) => {
            const linked = linkedIds.has(f.id)
            return (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={linked}
                  onClick={() => onPick(f)}
                  className={cn(
                    "w-full flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm",
                    linked
                      ? "opacity-60 cursor-default"
                      : "hover:bg-background/70 cursor-pointer"
                  )}
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{f.title}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {f.file_name}
                    </span>
                  </span>
                  <Badge tone="muted">{CATEGORY_LABEL[f.category]}</Badge>
                  {linked && <Check className="h-4 w-4 text-brand-600 shrink-0" />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
