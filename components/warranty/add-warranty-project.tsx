"use client"

import { useCallback, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Building2, Search, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn, formatDate } from "@/lib/utils"
import {
  listCrmWarrantyProjects,
  addWarrantyProjectFromCrm,
  type CrmWarrantyProject,
} from "@/app/actions/warranty"

/**
 * "Add project" for the Warranty page. Homes managed entirely outside this
 * app (in the CRM) still need a warranty punch list tracked here once they
 * close. This opens a picker of CRM homes that have a warranty period and
 * aren't in the app yet, and adopts the chosen one as a local warranty
 * project. Lives in the page header so it's reachable even when the tracker
 * is empty.
 */
export function AddWarrantyProjectButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [projects, setProjects] = useState<CrmWarrantyProject[]>([])
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Load CRM candidates fresh each time the dialog opens (a home that closed
  // yesterday should show today). Driven from the open handler rather than an
  // effect — this is a one-shot fetch in response to a user action.
  const openDialog = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    setLoadError(null)
    setSelectedId(null)
    setQuery("")
    try {
      const res = await listCrmWarrantyProjects()
      if (res.ok) setProjects(res.projects)
      else setLoadError(res.error)
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Could not load CRM projects"
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const q = query.trim().toLowerCase()
  const visible = q
    ? projects.filter(
        (p) =>
          p.project_number.toLowerCase().includes(q) ||
          p.address.toLowerCase().includes(q) ||
          (p.owner?.toLowerCase().includes(q) ?? false)
      )
    : projects

  function add() {
    if (!selectedId) return
    startTransition(async () => {
      try {
        const res = await addWarrantyProjectFromCrm({ crm_id: selectedId })
        if (res.ok) {
          const added = projects.find((p) => p.crm_id === selectedId)
          toast.success(
            `Added ${added?.address ?? "project"} for warranty tracking`
          )
          setOpen(false)
          router.refresh()
        } else {
          toast.error(res.error)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not add project")
      }
    })
  }

  return (
    <>
      <Button type="button" size="sm" onClick={openDialog}>
        <Building2 className="h-4 w-4" />
        Add project
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <div>
              <DialogTitle>Add a project for warranty tracking</DialogTitle>
              <DialogDescription>
                Pick a home from the CRM that was managed outside this app. It&apos;s
                added with a Warranty status so you can track its punch list here.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody>
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted z-10" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by address, owner, or job #"
                disabled={loading || !!loadError}
                className="pl-8"
              />
            </div>

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading CRM projects…
              </div>
            ) : loadError ? (
              <p className="py-8 text-center text-sm text-danger">{loadError}</p>
            ) : visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">
                {projects.length === 0
                  ? "No CRM projects are available to add — they may already be in this app."
                  : "No projects match your search."}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border max-h-[50vh] overflow-y-auto">
                {visible.map((p) => {
                  const selected = p.crm_id === selectedId
                  return (
                    <li key={p.crm_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(p.crm_id)}
                        className={cn(
                          "w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-background/60 cursor-pointer",
                          selected && "bg-brand-50"
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-4 w-4 shrink-0 rounded-full border",
                            selected
                              ? "border-brand-500 bg-brand-500 ring-2 ring-brand-500/30"
                              : "border-border-strong"
                          )}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[11px] text-muted shrink-0">
                              {p.project_number}
                            </span>
                            <span className="font-medium text-sm truncate">
                              {p.address}
                            </span>
                            {p.status && <Badge tone="muted">{p.status}</Badge>}
                          </span>
                          <span className="block text-xs text-muted mt-0.5 truncate">
                            {p.owner ? `Owner: ${p.owner}` : "Owner: —"}
                            {p.warranty_end_date
                              ? ` · Warranty ends ${formatDate(p.warranty_end_date)}`
                              : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={add} disabled={pending || !selectedId}>
              {pending ? "Adding…" : "Add project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
