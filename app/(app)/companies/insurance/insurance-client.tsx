"use client"

import { useMemo, useRef, useState, useTransition, type DragEvent } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  assignInsuranceDocument,
  deleteInsuranceDocument,
  deleteInsurancePolicy,
  getInsuranceDocumentUrl,
  processStoredInsuranceDocument,
  sendInsuranceRequest,
} from "@/app/actions/insurance"
import { companyRequiresInsurance } from "@/lib/insurance/requirements"
import type { Enums, Tables } from "@/lib/db/types"

type Company = Pick<
  Tables<"companies">,
  | "id"
  | "name"
  | "aka"
  | "type"
  | "email"
  | "contact_name"
  | "status"
  | "notifications_enabled"
  | "insurance_agent_name"
  | "insurance_agent_email"
  | "insurance_agent_phone"
>
type Policy = Pick<
  Tables<"insurance_policies">,
  | "id"
  | "company_id"
  | "document_id"
  | "type"
  | "carrier"
  | "policy_number"
  | "effective_date"
  | "expiration_date"
  | "reminder_sent_at"
>
type Doc = Pick<
  Tables<"insurance_documents">,
  | "id"
  | "company_id"
  | "file_name"
  | "file_type"
  | "source"
  | "doc_kind"
  | "email_from"
  | "email_subject"
  | "status"
  | "extracted_company_name"
  | "extraction_error"
  | "received_at"
>

type InsType = Enums<"insurance_type">
// Only GL + WC get table columns — that's what we require from every sub.
// Auto/umbrella policies are still extracted and stored; they show in the
// expanded per-company history, just not as columns.
const TYPE_ORDER: InsType[] = ["general_liability", "workers_comp"]
const TYPE_LABELS: Record<InsType, string> = {
  general_liability: "General Liability",
  workers_comp: "Workers' Comp",
  auto: "Auto",
  umbrella: "Umbrella",
}
const REQUIRED: InsType[] = ["general_liability", "workers_comp"]

type DocKind = "coi" | "w9" | "sma"
const DOC_KIND_LABELS: Record<DocKind, string> = {
  coi: "Certificate of insurance",
  w9: "W9",
  sma: "Master agreement (SMA)",
}
const DOC_KIND_SHORT: Record<DocKind, string> = {
  coi: "COI",
  w9: "W9",
  sma: "SMA",
}

const EXPIRING_SOON_DAYS = 30

// Files the pipeline can store: PDFs and images (the same set Claude can
// read for COI extraction — W9s/SMAs are stored without extraction but we
// keep the same accepted types for consistency).
function isAcceptedFile(file: File): boolean {
  if (file.type === "application/pdf" || file.type.startsWith("image/")) {
    return true
  }
  return /\.(pdf|jpe?g|png|gif|webp)$/i.test(file.name)
}

export function InsuranceClient({
  companies,
  policies,
  documents,
}: {
  companies: Company[]
  policies: Policy[]
  documents: Doc[]
}) {
  const [query, setQuery] = useState("")
  const [includeVendors, setIncludeVendors] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  // Only "Approved for Use" companies must carry insurance; the table shows
  // just those by default. Toggling this reveals everyone (useful to see a
  // cert that arrived for a not-yet-approved company).
  const [showAllStatuses, setShowAllStatuses] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null)
  const [exporting, setExporting] = useState(false)
  // Counter, not boolean: dragenter/dragleave fire for every child element
  // crossed, so a plain flag flickers off while moving across the page.
  const [dragDepth, setDragDepth] = useState(0)
  const [pending, startTransition] = useTransition()

  const [{ today, soon }] = useState(() => {
    const now = new Date()
    return {
      today: localISODate(now),
      soon: localISODate(new Date(now.getTime() + EXPIRING_SOON_DAYS * 86400_000)),
    }
  })

  // Latest policy per company+type = the current one; older rows are history.
  const currentByCompany = useMemo(() => {
    const map = new Map<string, Map<InsType, Policy>>()
    for (const p of policies) {
      let byType = map.get(p.company_id)
      if (!byType) {
        byType = new Map()
        map.set(p.company_id, byType)
      }
      const prev = byType.get(p.type)
      if (!prev || p.expiration_date > prev.expiration_date) byType.set(p.type, p)
    }
    return map
  }, [policies])

  const policiesByCompany = useMemo(() => {
    const map = new Map<string, Policy[]>()
    for (const p of policies) {
      const list = map.get(p.company_id) ?? []
      list.push(p)
      map.set(p.company_id, list)
    }
    return map
  }, [policies])

  // W9s / SMAs filed per company, newest first (the page query orders by
  // received_at desc). The first entry per kind is the current one.
  const extraDocsByCompany = useMemo(() => {
    const map = new Map<string, { w9: Doc[]; sma: Doc[] }>()
    for (const d of documents) {
      if (!d.company_id || d.status !== "processed") continue
      if (d.doc_kind !== "w9" && d.doc_kind !== "sma") continue
      let entry = map.get(d.company_id)
      if (!entry) {
        entry = { w9: [], sma: [] }
        map.set(d.company_id, entry)
      }
      entry[d.doc_kind as "w9" | "sma"].push(d)
    }
    return map
  }, [documents])

  const reviewQueue = documents.filter(
    (d) => d.status === "needs_review" || d.status === "failed" || d.status === "pending"
  )

  function companyProblemCount(c: Company): number {
    // Companies that aren't required to carry insurance can't have problems.
    if (!companyRequiresInsurance(c.status)) return 0
    const byType = currentByCompany.get(c.id)
    let problems = 0
    for (const t of REQUIRED) {
      const cur = byType?.get(t)
      if (!cur || cur.expiration_date < today || cur.expiration_date <= soon) problems++
    }
    return problems
  }

  const rows = companies
    .filter((c) => (includeVendors ? c.type !== "client" : c.type === "sub"))
    .filter((c) => showAllStatuses || companyRequiresInsurance(c.status))
    .filter((c) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        (c.aka ?? "").toLowerCase().includes(q)
      )
    })
    .filter((c) => !onlyProblems || companyProblemCount(c) > 0)

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allVisibleSelected =
    rows.length > 0 && rows.every((c) => selected.has(c.id))
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const c of rows) next.delete(c.id)
      } else {
        for (const c of rows) next.add(c.id)
      }
      return next
    })
  }

  // The audit bundle for a company: the documents behind its CURRENT
  // policies (all types, deduped — GL and WC may share one cert or come on
  // two) plus its latest W9 and latest SMA.
  const exportDocIds = useMemo(() => {
    const ids = new Set<string>()
    for (const cid of selected) {
      const byType = currentByCompany.get(cid)
      if (byType) {
        for (const p of byType.values()) {
          if (p.document_id) ids.add(p.document_id)
        }
      }
      const extra = extraDocsByCompany.get(cid)
      if (extra?.w9[0]) ids.add(extra.w9[0].id)
      if (extra?.sma[0]) ids.add(extra.sma[0].id)
    }
    return Array.from(ids)
  }, [selected, currentByCompany, extraDocsByCompany])

  async function exportSelected() {
    if (exportDocIds.length === 0) {
      toast.error("The selected companies have no documents on file")
      return
    }
    setExporting(true)
    try {
      const res = await fetch("/api/insurance/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: exportDocIds }),
      })
      if (!res.ok) {
        let msg = `Export failed (${res.status})`
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error) msg = body.error
        } catch {}
        toast.error(msg)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "insurance-documents.zip"
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(
        `Downloaded ${exportDocIds.length} document${exportDocIds.length === 1 ? "" : "s"}`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  function viewDocument(documentId: string) {
    startTransition(async () => {
      try {
        const url = await getInsuranceDocumentUrl(documentId)
        window.open(url, "_blank", "noopener")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open document")
      }
    })
  }

  function requestCert(c: Company) {
    startTransition(async () => {
      const result = await sendInsuranceRequest(c.id)
      if (result.sent) {
        toast.success(
          !c.email && c.insurance_agent_email
            ? `Request emailed to ${c.name}'s insurance agent`
            : c.insurance_agent_email
              ? `Request emailed to ${c.name} (agent copied)`
              : `Request emailed to ${c.name}`
        )
      } else toast.error(result.reason ?? "Could not send request")
    })
  }

  // Page-level drag & drop: dropping files anywhere on the page opens the
  // upload dialog preloaded with them.
  function onDragEnter(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth((d) => d + 1)
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
  }
  function onDragLeave(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth((d) => Math.max(0, d - 1))
  }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragDepth(0)
    const files = Array.from(e.dataTransfer.files).filter(isAcceptedFile)
    const skipped = e.dataTransfer.files.length - files.length
    if (skipped > 0) {
      toast.warning(
        `${skipped} file${skipped === 1 ? "" : "s"} skipped — only PDFs and images are supported`
      )
    }
    if (files.length === 0) return
    setDroppedFiles(files)
    setUploadOpen(true)
  }

  return (
    <div
      className="relative p-4 sm:p-6 space-y-6"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-brand-500 bg-brand-50/80">
          <div className="flex flex-col items-center gap-2 text-brand-700">
            <UploadCloud className="h-10 w-10" />
            <p className="text-sm font-medium">
              Drop documents to upload (PDFs or images)
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Subcontractor insurance
          </h1>
          <p className="text-sm text-muted-foreground">
            Certificates emailed to the insurance inbox are read and filed
            automatically — W9s and master agreements live here too. Drag
            files onto this page to upload several at once.{" "}
            <Link href="/companies" className="text-brand-600 hover:underline">
              Back to companies
            </Link>
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>Upload documents</Button>
      </div>

      {reviewQueue.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            Needs review ({reviewQueue.length})
          </h2>
          <div className="space-y-2">
            {reviewQueue.map((d) => (
              <ReviewCard
                key={d.id}
                doc={d}
                companies={companies}
                onView={() => viewDocument(d.id)}
                pending={pending}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search companies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeVendors}
              onChange={(e) => setIncludeVendors(e.target.checked)}
            />
            Include vendors
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            Only problems
          </label>
          <label
            className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer"
            title='Insurance is only required from companies marked "Approved for Use"'
          >
            <input
              type="checkbox"
              checked={showAllStatuses}
              onChange={(e) => setShowAllStatuses(e.target.checked)}
            />
            Show all statuses
          </label>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm">
            <span className="font-medium text-foreground">
              {selected.size} compan{selected.size === 1 ? "y" : "ies"} selected
            </span>
            <Button
              size="sm"
              onClick={exportSelected}
              disabled={exporting || exportDocIds.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              {exporting
                ? "Preparing ZIP…"
                : `Download documents (${exportDocIds.length})`}
            </Button>
            <span className="text-xs text-muted-foreground">
              Current certificates + latest W9 and SMA per company, zipped for
              audits.
            </span>
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => setSelected(new Set())}
            >
              <X className="h-3 w-3" /> Clear
            </button>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState
            title="No companies to show"
            description="Adjust the filters above, or add subcontractors on the Companies page."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all listed companies"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Company</th>
                  {TYPE_ORDER.map((t) => (
                    <th key={t} className="px-3 py-2 font-medium">
                      {TYPE_LABELS[t]}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium">Docs</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const byType = currentByCompany.get(c.id)
                  const isOpen = expanded.has(c.id)
                  const history = policiesByCompany.get(c.id) ?? []
                  const extraDocs = extraDocsByCompany.get(c.id)
                  return (
                    <CompanyRows
                      key={c.id}
                      company={c}
                      byType={byType}
                      history={history}
                      extraDocs={extraDocs}
                      today={today}
                      soon={soon}
                      isOpen={isOpen}
                      isSelected={selected.has(c.id)}
                      onSelect={() => toggleSelect(c.id)}
                      onToggle={() => toggleExpand(c.id)}
                      onView={viewDocument}
                      onRequest={() => requestCert(c)}
                      pending={pending}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={(v) => {
          setUploadOpen(v)
          if (!v) setDroppedFiles(null)
        }}
        companies={companies}
        initialFiles={droppedFiles}
      />
    </div>
  )
}

function CompanyRows({
  company,
  byType,
  history,
  extraDocs,
  today,
  soon,
  isOpen,
  isSelected,
  onSelect,
  onToggle,
  onView,
  onRequest,
  pending,
}: {
  company: Company
  byType: Map<InsType, Policy> | undefined
  history: Policy[]
  extraDocs: { w9: Doc[]; sma: Doc[] } | undefined
  today: string
  soon: string
  isOpen: boolean
  isSelected: boolean
  onSelect: () => void
  onToggle: () => void
  onView: (documentId: string) => void
  onRequest: () => void
  pending: boolean
}) {
  const [, startTransition] = useTransition()
  const latestW9 = extraDocs?.w9[0]
  const latestSma = extraDocs?.sma[0]
  const canEmail = Boolean(company.email || company.insurance_agent_email)
  const agentBits = [
    company.insurance_agent_name,
    company.insurance_agent_email,
    company.insurance_agent_phone,
  ].filter(Boolean)
  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-background/60">
        <td className="px-3 py-2">
          <input
            type="checkbox"
            aria-label={`Select ${company.name}`}
            checked={isSelected}
            onChange={onSelect}
          />
        </td>
        <td className="px-3 py-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 font-medium text-foreground cursor-pointer text-left"
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span>
              {company.name}
              {company.aka && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (AKA {company.aka})
                </span>
              )}
              {!companyRequiresInsurance(company.status) && (
                // Visible via "Show all statuses" — explain why nothing is
                // flagged for this row.
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({company.status ?? "no status"})
                </span>
              )}
            </span>
          </button>
        </td>
        {TYPE_ORDER.map((t) => (
          <td key={t} className="px-3 py-2">
            <CoverageCell
              policy={byType?.get(t)}
              required={
                REQUIRED.includes(t) && companyRequiresInsurance(company.status)
              }
              today={today}
              soon={soon}
            />
          </td>
        ))}
        <td className="px-3 py-2 whitespace-nowrap">
          <div className="flex items-center gap-1">
            <DocChip label="W9" doc={latestW9} onView={onView} />
            <DocChip label="SMA" doc={latestSma} onView={onView} />
          </div>
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !canEmail}
            title={
              canEmail
                ? company.insurance_agent_email
                  ? "Emails the company and CCs their insurance agent"
                  : undefined
                : "No email on file for the company or its insurance agent"
            }
            onClick={onRequest}
          >
            Send request
          </Button>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-border last:border-0 bg-background/40">
          <td colSpan={TYPE_ORDER.length + 4} className="px-3 py-2 space-y-2">
            {agentBits.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  Insurance agent:
                </span>{" "}
                {agentBits.join(" · ")}
                {company.insurance_agent_email && (
                  <span> — CC&rsquo;d on certificate requests</span>
                )}
              </p>
            )}
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">
                No policies on file yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {history.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">
                      {TYPE_LABELS[p.type]}
                    </span>
                    {p.carrier && <span>{p.carrier}</span>}
                    {p.policy_number && <span>#{p.policy_number}</span>}
                    <span>
                      {p.effective_date ? `${p.effective_date} → ` : ""}
                      {p.expiration_date}
                    </span>
                    {p.document_id && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5 text-brand-600 hover:underline cursor-pointer"
                        onClick={() => onView(p.document_id!)}
                      >
                        <ExternalLink className="h-3 w-3" /> cert
                      </button>
                    )}
                    <button
                      type="button"
                      className="inline-flex items-center text-muted-foreground hover:text-danger cursor-pointer"
                      title="Delete this policy row"
                      onClick={() =>
                        startTransition(async () => {
                          try {
                            await deleteInsurancePolicy(p.id)
                            toast.success("Policy removed")
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : "Delete failed"
                            )
                          }
                        })
                      }
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(extraDocs?.w9.length || extraDocs?.sma.length) ? (
              <ul className="space-y-1 border-t border-border pt-2">
                {[...(extraDocs?.w9 ?? []), ...(extraDocs?.sma ?? [])].map(
                  (d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {DOC_KIND_SHORT[(d.doc_kind as DocKind) ?? "coi"]}
                      </span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5 text-brand-600 hover:underline cursor-pointer"
                        onClick={() => onView(d.id)}
                      >
                        <FileText className="h-3 w-3" /> {d.file_name}
                      </button>
                      <span>received {d.received_at.slice(0, 10)}</span>
                      <button
                        type="button"
                        className="inline-flex items-center text-muted-foreground hover:text-danger cursor-pointer"
                        title="Delete this document"
                        onClick={() => {
                          // Permanently removes the row AND the stored file —
                          // gate the click like the company-delete flow does.
                          if (
                            !confirm(
                              `Delete ${d.file_name}? The stored file is removed permanently.`
                            )
                          )
                            return
                          startTransition(async () => {
                            try {
                              await deleteInsuranceDocument(d.id)
                              toast.success("Document deleted")
                            } catch (e) {
                              toast.error(
                                e instanceof Error ? e.message : "Delete failed"
                              )
                            }
                          })
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </li>
                  )
                )}
              </ul>
            ) : null}
          </td>
        </tr>
      )}
    </>
  )
}

// W9 / SMA presence chip: green + clickable when the doc is on file, muted
// dash otherwise.
function DocChip({
  label,
  doc,
  onView,
}: {
  label: string
  doc: Doc | undefined
  onView: (documentId: string) => void
}) {
  if (!doc) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title={`No ${label} on file`}
      >
        {label} —
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onView(doc.id)}
      title={`${doc.file_name} — received ${doc.received_at.slice(0, 10)}. Click to view.`}
      className="inline-flex items-center gap-0.5 rounded-full bg-success/10 text-success border border-success/30 px-1.5 py-0.5 text-[11px] cursor-pointer hover:bg-success/20"
    >
      {label} ✓
    </button>
  )
}

function CoverageCell({
  policy,
  required,
  today,
  soon,
}: {
  policy: Policy | undefined
  required: boolean
  today: string
  soon: string
}) {
  if (!policy) {
    return required ? (
      <Badge tone="warning">None on file</Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }
  const exp = policy.expiration_date
  const detail = [policy.carrier, policy.policy_number && `#${policy.policy_number}`]
    .filter(Boolean)
    .join(" ")
  if (exp < today) {
    return (
      <span title={detail}>
        <Badge tone="danger">Expired {exp}</Badge>
      </span>
    )
  }
  if (exp <= soon) {
    return (
      <span title={detail}>
        <Badge tone="warning">Expires {exp}</Badge>
      </span>
    )
  }
  return (
    <span title={detail}>
      <Badge tone="success">Thru {exp}</Badge>
    </span>
  )
}

function ReviewCard({
  doc,
  companies,
  onView,
  pending,
}: {
  doc: Doc
  companies: Company[]
  onView: () => void
  pending: boolean
}) {
  const [companyId, setCompanyId] = useState("")
  const [busy, startTransition] = useTransition()

  const origin =
    doc.source === "email"
      ? `Emailed by ${doc.email_from ?? "unknown"}${
          doc.email_subject ? ` — "${doc.email_subject}"` : ""
        }`
      : doc.source === "upload"
        ? "Uploaded via sub link"
        : "Uploaded by staff"

  return (
    <div className="rounded-lg border border-border bg-surface p-3 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onView}
            className="font-medium text-foreground hover:underline cursor-pointer truncate"
          >
            {doc.file_name}
          </button>
          {doc.doc_kind !== "coi" && (
            <Badge tone="info">
              {DOC_KIND_SHORT[(doc.doc_kind as DocKind) ?? "coi"]}
            </Badge>
          )}
          {doc.status === "failed" ? (
            <Badge tone="danger">Extraction failed</Badge>
          ) : doc.status === "pending" ? (
            <Badge tone="muted">Processing…</Badge>
          ) : (
            <Badge tone="warning">Unmatched</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {origin}
          {doc.extracted_company_name && (
            <> · cert says “{doc.extracted_company_name}”</>
          )}
          {doc.extraction_error && <> · {doc.extraction_error}</>}
        </p>
      </div>
      {doc.status === "needs_review" && (
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">Assign to company…</option>
            {companies
              .filter((c) => c.type !== "client")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.aka ? ` (AKA ${c.aka})` : ""}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            disabled={!companyId || busy || pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  await assignInsuranceDocument(doc.id, companyId)
                  toast.success("Document filed")
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Assign failed")
                }
              })
            }
          >
            Assign
          </Button>
        </div>
      )}
      <Button
        variant="ghost"
        size="icon"
        title="Delete this document"
        disabled={busy || pending}
        onClick={() => {
          if (
            !confirm(
              `Delete ${doc.file_name}? The stored file is removed permanently.`
            )
          )
            return
          startTransition(async () => {
            try {
              await deleteInsuranceDocument(doc.id)
              toast.success("Document deleted")
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Delete failed")
            }
          })
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

function UploadDialog({
  open,
  onOpenChange,
  companies,
  initialFiles,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  companies: Company[]
  initialFiles: File[] | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Each picked file carries its own generated id: React keys stay stable
  // and unique even when two different files share a name and size, and
  // nothing is silently dropped as a "duplicate".
  const [files, setFiles] = useState<{ id: string; file: File }[]>([])
  const [companyId, setCompanyId] = useState("")
  const [docKind, setDocKind] = useState<DocKind>("coi")
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState("")
  // Adopt files dropped on the page. Keyed on the array identity so a second
  // drop while the dialog is open replaces the list.
  const [adoptedFrom, setAdoptedFrom] = useState<File[] | null>(null)
  if (initialFiles && initialFiles !== adoptedFrom) {
    setAdoptedFrom(initialFiles)
    setFiles(initialFiles.map((file) => ({ id: crypto.randomUUID(), file })))
  }

  function addFiles(picked: FileList | File[] | null) {
    if (!picked) return
    const accepted = Array.from(picked).filter(isAcceptedFile)
    const skipped = Array.from(picked).length - accepted.length
    if (skipped > 0) {
      toast.warning(
        `${skipped} file${skipped === 1 ? "" : "s"} skipped — only PDFs and images are supported`
      )
    }
    if (accepted.length === 0) return
    setFiles((prev) => [
      ...prev,
      ...accepted.map((file) => ({ id: crypto.randomUUID(), file })),
    ])
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  async function submit() {
    if (files.length === 0) return
    if (docKind !== "coi" && !companyId) {
      toast.error(
        `Pick the company these ${DOC_KIND_SHORT[docKind]}s belong to — they aren't auto-matched like certificates.`
      )
      return
    }
    setBusy(true)
    try {
      // Browser → Storage directly with the staff JWT (same pattern as
      // daily-log attachments), then the server action ingests from the
      // stored object. Avoids server-action body-size limits on big PDFs.
      // Sequential on purpose: COI extraction is the slow step and parallel
      // Claude calls just trip rate limits.
      const supabase = createSupabaseBrowserClient()
      let processed = 0
      let needsReview = 0
      let failed = 0
      for (let i = 0; i < files.length; i++) {
        const file = files[i].file
        setProgress(
          files.length > 1
            ? `Reading ${i + 1} of ${files.length} — ${file.name}`
            : "Reading document…"
        )
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "pdf"
        const path = `companies/insurance/${crypto.randomUUID()}.${ext}`
        const { error } = await supabase.storage
          .from("project-files")
          .upload(path, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined,
          })
        if (error) {
          failed++
          toast.error(`${file.name}: upload failed — ${error.message}`)
          continue
        }
        // Per-file try/catch: one bad file must not abort the rest of the
        // batch. On a typed failure (`ok:false` — guaranteed to mean no
        // document row was recorded) remove the just-uploaded object so a
        // sensitive W9/cert never lingers in Storage with nothing in the
        // database pointing at it. A THROWN error is different: the server
        // may have completed the ingest before the response was lost, so
        // the object stays (worst case it's cleaned up manually) rather
        // than risking deleting a file a document row now references.
        try {
          const result = await processStoredInsuranceDocument({
            storagePath: path,
            fileName: file.name,
            fileType: file.type || "application/pdf",
            fileSize: file.size,
            companyId: companyId || null,
            docKind,
          })
          if (!result.ok) {
            failed++
            toast.error(`${file.name}: ${result.error}`)
            const { error: rmErr } = await supabase.storage
              .from("project-files")
              .remove([path])
            if (rmErr) {
              console.warn("orphaned upload cleanup failed:", rmErr.message)
            }
          } else if (result.status === "processed") {
            processed++
          } else if (result.status === "needs_review") {
            needsReview++
          } else {
            failed++
          }
        } catch (e) {
          failed++
          console.error("processStoredInsuranceDocument threw:", e)
          toast.error(`${file.name}: processing failed — try re-uploading it`)
        }
      }
      if (processed > 0) {
        toast.success(
          processed === 1
            ? "1 document read and filed"
            : `${processed} documents read and filed`
        )
      }
      if (needsReview > 0) {
        toast.info(
          `${needsReview} document${needsReview === 1 ? "" : "s"} stored — couldn't match a company, see the review queue`
        )
      }
      if (failed > 0 && processed === 0 && needsReview === 0) {
        toast.warning("Nothing filed — see the errors above")
      }
      // Clear the native input too, or re-picking the same file next time
      // won't fire onChange.
      if (inputRef.current) inputRef.current.value = ""
      setFiles([])
      setCompanyId("")
      setDocKind("coi")
      onOpenChange(false)
    } finally {
      setBusy(false)
      setProgress("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Upload documents</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click()
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
              className="w-full rounded-lg border-2 border-dashed border-border-strong bg-background p-5 text-center text-sm text-muted-foreground hover:border-brand-500 hover:text-foreground transition-colors cursor-pointer"
            >
              {files.length === 0 ? (
                <>Choose or drop PDFs / images — several at once is fine</>
              ) : (
                <span className="font-medium text-foreground">
                  {files.length} file{files.length === 1 ? "" : "s"} ready —
                  click to add more
                </span>
              )}
            </div>
            {files.length > 0 && (
              <ul className="max-h-32 overflow-y-auto space-y-1 text-xs">
                {files.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center gap-2 text-muted-foreground"
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="truncate">{f.file.name}</span>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-danger cursor-pointer"
                      onClick={() => removeFile(f.id)}
                      disabled={busy}
                      aria-label={`Remove ${f.file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Document type (applies to every file in this batch)
              </label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-sm"
                value={docKind}
                onChange={(e) => setDocKind(e.target.value as DocKind)}
              >
                {(Object.keys(DOC_KIND_LABELS) as DocKind[]).map((k) => (
                  <option key={k} value={k}>
                    {DOC_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {docKind === "coi"
                  ? "Company (optional — leave blank to auto-match from the certificate)"
                  : "Company (required — W9s and SMAs aren't auto-matched)"}
              </label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-sm"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">
                  {docKind === "coi" ? "Auto-match" : "Choose a company…"}
                </option>
                {companies
                  .filter((c) => c.type !== "client")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.aka ? ` (AKA ${c.aka})` : ""}
                    </option>
                  ))}
              </select>
            </div>
            {busy && progress && (
              <p className="text-xs text-muted-foreground">{progress}</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={files.length === 0 || busy}>
            {busy
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

function localISODate(d: Date): string {
  return d.toLocaleDateString("en-CA")
}
