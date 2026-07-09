"use client"

import { useState, useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Building2, Trash2, Search, BellOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
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
import { TradeChipsEditor } from "@/components/companies/trade-chips-editor"
import type { Tables, Enums } from "@/lib/db/types"

export function CompaniesClient({
  companies,
  tradesByCompany,
  allTrades,
}: {
  companies: Tables<"companies">[]
  tradesByCompany: Record<string, string[]>
  allTrades: string[]
}) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<"all" | Enums<"company_type">>(
    "all"
  )
  // Trade filter chip: click a trade chip in the toolbar to constrain the
  // list to companies tagged with it. Clear by clicking again.
  const [tradeFilter, setTradeFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState<
    Tables<"companies"> | "new" | null
  >(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return companies
      .filter((c) => typeFilter === "all" || c.type === typeFilter)
      .filter((c) => {
        if (!tradeFilter) return true
        return (tradesByCompany[c.id] ?? []).includes(tradeFilter)
      })
      .filter((c) => {
        if (!q) return true
        const trades = (tradesByCompany[c.id] ?? []).join(" ")
        return (
          c.name.toLowerCase().includes(q) ||
          (c.trade_category ?? "").toLowerCase().includes(q) ||
          trades.includes(q) ||
          (c.contact_name ?? "").toLowerCase().includes(q) ||
          (c.status ?? "").toLowerCase().includes(q) ||
          (c.city ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.phone ?? "").toLowerCase().includes(q)
        )
      })
  }, [companies, search, typeFilter, tradeFilter, tradesByCompany])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-muted">
            Subcontractors and vendors.
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

      {allTrades.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted mr-1">
            Trade
          </span>
          {allTrades.map((t) => {
            const active = tradeFilter === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTradeFilter(active ? null : t)}
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
          {tradeFilter && (
            <button
              type="button"
              onClick={() => setTradeFilter(null)}
              className="text-[11px] text-muted hover:text-foreground underline cursor-pointer"
            >
              clear
            </button>
          )}
        </div>
      )}

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
                <th className="text-left px-4 py-2.5 hidden lg:table-cell w-44">
                  Status
                </th>
                <th className="text-left px-4 py-2.5 hidden md:table-cell">
                  Contact
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((c) => {
                const companyTrades = tradesByCompany[c.id] ?? []
                return (
                  <tr
                    key={c.id}
                    onClick={() => setEditing(c)}
                    className="hover:bg-background/40 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {c.name}
                        {!c.notifications_enabled && (
                          <BellOff
                            className="h-3.5 w-3.5 text-muted shrink-0"
                            aria-label="Notifications off"
                          />
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={c.type} />
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {companyTrades.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {companyTrades.map((t) => (
                            <span
                              key={t}
                              className="inline-flex rounded-full bg-brand-100 text-brand-700 text-[11px] px-1.5 py-0.5"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : c.trade_category ? (
                        <span>{c.trade_category}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-muted">
                      {c.status || "—"}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted">
                      {c.contact_name || c.email || c.phone || "—"}
                    </td>
                  </tr>
                )
              })}
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
          initialTrades={
            editing === "new" ? [] : tradesByCompany[editing.id] ?? []
          }
          allTrades={allTrades}
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
  initialTrades,
  allTrades,
  onClose,
}: {
  company: Tables<"companies"> | null
  initialTrades: string[]
  allTrades: string[]
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(company?.name ?? "")
  const [type, setType] = useState<Enums<"company_type">>(company?.type ?? "sub")
  const [trades, setTrades] = useState<string[]>(initialTrades)
  const [address, setAddress] = useState(company?.address ?? "")
  const [phone, setPhone] = useState(company?.phone ?? "")
  const [email, setEmail] = useState(company?.email ?? "")
  const [notes, setNotes] = useState(company?.notes ?? "")
  const [contactName, setContactName] = useState(company?.contact_name ?? "")
  const [phoneSecondary, setPhoneSecondary] = useState(
    company?.phone_secondary ?? ""
  )
  const [city, setCity] = useState(company?.city ?? "")
  const [stateField, setStateField] = useState(company?.state ?? "")
  const [postalCode, setPostalCode] = useState(company?.postal_code ?? "")
  const [website, setWebsite] = useState(company?.website ?? "")
  const [status, setStatus] = useState(company?.status ?? "")
  // New companies default to notifications ON; existing ones reflect their flag.
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    company ? company.notifications_enabled : true
  )

  function submit() {
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    const payload: CompanyInputT = {
      id: company?.id,
      name: name.trim(),
      type,
      // Legacy trade_category kept in sync server-side (mirrors the first
      // trade). We send empty here so the server picks the first trade.
      trade_category: null,
      trades,
      address: address || null,
      phone: phone || null,
      email: email || null,
      notes: notes || null,
      contact_name: contactName || null,
      phone_secondary: phoneSecondary || null,
      city: city || null,
      state: stateField || null,
      postal_code: postalCode || null,
      website: website || null,
      status: status || null,
      notifications_enabled: notificationsEnabled,
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
            <Field label="Status">
              <Input
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder="e.g. Approved for Use"
                list="company-status-options"
              />
              <datalist id="company-status-options">
                <option value="Approved for Use" />
                <option value="Interviewed" />
                <option value="Not Contacted" />
                <option value="Inactive" />
                <option value="Not for Hire" />
                <option value="Insurance Requirement Waived" />
              </datalist>
            </Field>
            <div className="sm:col-span-2">
              <TradeChipsEditor
                value={trades}
                onChange={setTrades}
                suggestions={allTrades}
              />
            </div>
            <Field label="Primary contact">
              <Input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </Field>
            <Field label="Website">
              <Input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="example.com"
              />
            </Field>
            <Field label="Phone">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Secondary phone">
              <Input
                type="tel"
                value={phoneSecondary}
                onChange={(e) => setPhoneSecondary(e.target.value)}
              />
            </Field>
            <Field label="Email" className="sm:col-span-2">
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
            <Field label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <Input
                  value={stateField}
                  onChange={(e) => setStateField(e.target.value)}
                />
              </Field>
              <Field label="ZIP">
                <Input
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label="Notifications" className="sm:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(e) => setNotificationsEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-strong"
                />
                <span>
                  <span className="font-medium">
                    Send assignment notifications
                  </span>
                  <span className="block text-xs text-muted">
                    When on, this company gets a text/email when assigned to a
                    schedule item. Turn off to keep them quiet (e.g. while
                    testing).
                  </span>
                </span>
              </label>
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
