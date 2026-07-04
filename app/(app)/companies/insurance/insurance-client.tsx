"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, ExternalLink, Trash2 } from "lucide-react"
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
import type { Enums, Tables } from "@/lib/db/types"

type Company = Pick<
  Tables<"companies">,
  "id" | "name" | "type" | "email" | "contact_name" | "status" | "notifications_enabled"
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
  | "email_from"
  | "email_subject"
  | "status"
  | "extracted_company_name"
  | "extraction_error"
  | "received_at"
>

type InsType = Enums<"insurance_type">
const TYPE_ORDER: InsType[] = ["general_liability", "workers_comp", "auto", "umbrella"]
const TYPE_LABELS: Record<InsType, string> = {
  general_liability: "General Liability",
  workers_comp: "Workers' Comp",
  auto: "Auto",
  umbrella: "Umbrella",
}
// GL + WC are what we require from every sub; auto/umbrella are tracked
// when present but their absence isn't flagged.
const REQUIRED: InsType[] = ["general_liability", "workers_comp"]

const EXPIRING_SOON_DAYS = 30

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
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

  const reviewQueue = documents.filter(
    (d) => d.status === "needs_review" || d.status === "failed" || d.status === "pending"
  )

  function companyProblemCount(c: Company): number {
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
    .filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((c) => !onlyProblems || companyProblemCount(c) > 0)

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
      if (result.sent) toast.success(`Request emailed to ${c.name}`)
      else toast.error(result.reason ?? "Could not send request")
    })
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Subcontractor insurance
          </h1>
          <p className="text-sm text-muted-foreground">
            Certificates emailed to the insurance inbox are read and filed
            automatically. Subs get an email one week before coverage lapses.{" "}
            <Link href="/companies" className="text-brand-600 hover:underline">
              Back to companies
            </Link>
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>Upload certificate</Button>
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
        </div>

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
                  <th className="px-3 py-2 font-medium">Company</th>
                  {TYPE_ORDER.map((t) => (
                    <th key={t} className="px-3 py-2 font-medium">
                      {TYPE_LABELS[t]}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const byType = currentByCompany.get(c.id)
                  const isOpen = expanded.has(c.id)
                  const history = policiesByCompany.get(c.id) ?? []
                  return (
                    <CompanyRows
                      key={c.id}
                      company={c}
                      byType={byType}
                      history={history}
                      today={today}
                      soon={soon}
                      isOpen={isOpen}
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
        onOpenChange={setUploadOpen}
        companies={companies}
      />
    </div>
  )
}

function CompanyRows({
  company,
  byType,
  history,
  today,
  soon,
  isOpen,
  onToggle,
  onView,
  onRequest,
  pending,
}: {
  company: Company
  byType: Map<InsType, Policy> | undefined
  history: Policy[]
  today: string
  soon: string
  isOpen: boolean
  onToggle: () => void
  onView: (documentId: string) => void
  onRequest: () => void
  pending: boolean
}) {
  const [, startTransition] = useTransition()
  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-background/60">
        <td className="px-3 py-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 font-medium text-foreground cursor-pointer"
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {company.name}
          </button>
        </td>
        {TYPE_ORDER.map((t) => (
          <td key={t} className="px-3 py-2">
            <CoverageCell
              policy={byType?.get(t)}
              required={REQUIRED.includes(t)}
              today={today}
              soon={soon}
            />
          </td>
        ))}
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !company.email}
            title={company.email ? undefined : "No email on file"}
            onClick={onRequest}
          >
            Send request
          </Button>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-border last:border-0 bg-background/40">
          <td colSpan={TYPE_ORDER.length + 2} className="px-3 py-2">
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
          </td>
        </tr>
      )}
    </>
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
                  toast.success("Certificate filed")
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
        onClick={() =>
          startTransition(async () => {
            try {
              await deleteInsuranceDocument(doc.id)
              toast.success("Document deleted")
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Delete failed")
            }
          })
        }
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
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  companies: Company[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [companyId, setCompanyId] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!file) return
    setBusy(true)
    try {
      // Browser → Storage directly with the staff JWT (same pattern as
      // daily-log attachments), then the server action ingests from the
      // stored object. Avoids server-action body-size limits on big PDFs.
      const supabase = createSupabaseBrowserClient()
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
        toast.error(`Upload failed: ${error.message}`)
        return
      }
      const result = await processStoredInsuranceDocument({
        storagePath: path,
        fileName: file.name,
        fileType: file.type || "application/pdf",
        fileSize: file.size,
        companyId: companyId || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.status === "processed") {
        toast.success("Certificate read and filed")
      } else if (result.status === "needs_review") {
        toast.info("Certificate stored — couldn't match a company, see the review queue")
      } else {
        toast.warning("File stored but extraction failed — see the review queue")
      }
      setFile(null)
      setCompanyId("")
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Upload a certificate</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full rounded-lg border-2 border-dashed border-border-strong bg-background p-5 text-center text-sm text-muted-foreground hover:border-brand-500 hover:text-foreground transition-colors cursor-pointer"
            >
              {file ? (
                <span className="font-medium text-foreground">{file.name}</span>
              ) : (
                <>Choose a PDF or image</>
              )}
            </button>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Company (optional — leave blank to auto-match from the
                certificate)
              </label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-sm"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Auto-match</option>
                {companies
                  .filter((c) => c.type !== "client")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || busy}>
            {busy ? "Reading certificate…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function localISODate(d: Date): string {
  return d.toLocaleDateString("en-CA")
}
