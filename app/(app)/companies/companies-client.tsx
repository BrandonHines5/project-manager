"use client"

import { useState, useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Building2, Trash2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import {
  saveCompany,
  deleteCompany,
  type CompanyInputT,
} from "@/app/actions/companies"
import type { Tables, Enums } from "@/lib/db/types"

export function CompaniesClient({
  companies,
}: {
  companies: Tables<"companies">[]
}) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<"all" | Enums<"company_type">>(
    "all"
  )
  const [editing, setEditing] = useState<
    Tables<"companies"> | "new" | null
  >(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return companies
      .filter((c) => typeFilter === "all" || c.type === typeFilter)
      .filter((c) => {
        if (!q) return true
        return (
          c.name.toLowerCase().includes(q) ||
          (c.trade_category ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.phone ?? "").toLowerCase().includes(q)
        )
      })
  }, [companies, search, typeFilter])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-muted">
            Subcontractors, vendors, and client households.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(e.target.value as "all" | Enums<"company_type">)
            }
            className="w-auto"
          >
            <option value="all">All types</option>
            <option value="sub">Subcontractors</option>
            <option value="vendor">Vendors</option>
            <option value="client">Clients</option>
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
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> New company
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title={
            companies.length === 0 ? "No companies yet" : "No matches"
          }
          description={
            companies.length === 0
              ? "Add subcontractors and vendors so you can assign them to schedule items."
              : "Try different search terms."
          }
          action={
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> New company
            </Button>
          }
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5 w-32">Type</th>
                <th className="text-left px-4 py-2.5">Trade / category</th>
                <th className="text-left px-4 py-2.5 hidden md:table-cell">
                  Contact
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setEditing(c)}
                  className="hover:bg-background/40 cursor-pointer"
                >
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3">
                    <TypeBadge type={c.type} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {c.trade_category || "—"}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted">
                    {c.email || c.phone || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CompanyDialog
          // Remount the dialog when switching rows so useState reinitialises
          // from the new prop instead of keeping the previous row's values.
          key={editing === "new" ? "new" : editing.id}
          company={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function TypeBadge({ type }: { type: Enums<"company_type"> }) {
  if (type === "sub")
    return <Badge tone="brand">Sub</Badge>
  if (type === "vendor")
    return <Badge tone="info">Vendor</Badge>
  return <Badge tone="success">Client</Badge>
}

function CompanyDialog({
  company,
  onClose,
}: {
  company: Tables<"companies"> | null
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(company?.name ?? "")
  const [type, setType] = useState<Enums<"company_type">>(company?.type ?? "sub")
  const [tradeCategory, setTradeCategory] = useState(
    company?.trade_category ?? ""
  )
  const [address, setAddress] = useState(company?.address ?? "")
  const [phone, setPhone] = useState(company?.phone ?? "")
  const [email, setEmail] = useState(company?.email ?? "")
  const [notes, setNotes] = useState(company?.notes ?? "")

  function submit() {
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    const payload: CompanyInputT = {
      id: company?.id,
      name: name.trim(),
      type,
      trade_category: tradeCategory || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      notes: notes || null,
    }
    startTransition(async () => {
      try {
        await saveCompany(payload)
        toast.success(company ? "Saved" : "Created")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  function handleDelete() {
    if (!company) return
    if (!confirm(`Delete ${company.name}? They'll be removed from any assignments.`))
      return
    startTransition(async () => {
      try {
        await deleteCompany(company.id)
        toast.success("Deleted")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{company ? company.name : "New company"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name" className="sm:col-span-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Type">
              <Select
                value={type}
                onChange={(e) => setType(e.target.value as Enums<"company_type">)}
              >
                <option value="sub">Subcontractor</option>
                <option value="vendor">Vendor</option>
                <option value="client">Client household</option>
              </Select>
            </Field>
            <Field label="Trade / category">
              <Input
                value={tradeCategory}
                onChange={(e) => setTradeCategory(e.target.value)}
                placeholder="Electrical, Plumbing, Cabinets…"
              />
            </Field>
            <Field label="Phone">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          {company && (
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
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
