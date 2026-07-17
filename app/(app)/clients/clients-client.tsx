"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search, Contact, Mail, Phone } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import type { Enums } from "@/lib/db/types"

export type ClientJob = {
  id: string
  number: string
  name: string
  status: Enums<"project_status">
}

export type ClientRow = {
  key: string
  name: string
  email: string | null
  phone: string | null
  jobs: ClientJob[]
}

// Tones/labels mirror the projects table so a job's status reads the same
// wherever it appears.
const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "warning" | "success" | "danger" | "info"
> = {
  upcoming: "info",
  in_work: "brand",
  inventory: "info",
  paused: "warning",
  complete: "success",
  warranty: "info",
  cancelled: "danger",
}

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  upcoming: "Upcoming",
  in_work: "In Work",
  inventory: "Inventory",
  paused: "Paused",
  complete: "Complete",
  warranty: "Warranty",
  cancelled: "Cancelled",
}

// Phones are stored as free text ("(501) 555-1234"); dialers want a clean
// tel: target. Bare 10-digit US numbers get +1 so tapping the link dials
// correctly from any phone.
function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `tel:+${digits}`
  if (digits.length === 10) return `tel:+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`
  return `tel:${digits || phone.trim()}`
}

export function ClientsClient({ clients }: { clients: ClientRow[] }) {
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return clients
    return clients.filter((c) => {
      const hay = [
        c.name,
        c.email ?? "",
        c.phone ?? "",
        ...c.jobs.map((j) => `${j.number} ${j.name}`),
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [clients, search])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="text-sm text-muted">
            Homeowners assigned to jobs, pulled from each job&rsquo;s client
            contacts.
          </p>
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients or jobs…"
            className="pl-8 w-full sm:w-64"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Contact className="h-10 w-10" />}
          title={clients.length === 0 ? "No clients yet" : "No matches"}
          description={
            clients.length === 0
              ? "Clients appear here once a job has a client contact on file."
              : "Try different search terms."
          }
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-background/60 text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">Client</th>
                  <th className="text-left px-4 py-2.5">Contact</th>
                  <th className="text-left px-4 py-2.5">Jobs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => (
                  <tr key={c.key} className="align-top">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-muted">
                      <div className="space-y-0.5">
                        {c.email && (
                          <a
                            href={`mailto:${c.email}`}
                            className="flex items-center gap-1.5 text-brand-700 hover:underline w-fit"
                          >
                            <Mail className="h-3.5 w-3.5 shrink-0" /> {c.email}
                          </a>
                        )}
                        {c.phone && (
                          <a
                            href={telHref(c.phone)}
                            className="flex items-center gap-1.5 text-brand-700 hover:underline w-fit"
                          >
                            <Phone className="h-3.5 w-3.5 shrink-0" /> {c.phone}
                          </a>
                        )}
                        {!c.email && !c.phone && "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        {c.jobs.map((j) => (
                          <Link
                            key={j.id}
                            href={`/projects/${j.id}`}
                            className="inline-flex items-center gap-2 w-fit group"
                          >
                            <span className="text-muted tabular-nums">
                              #{j.number}
                            </span>
                            <span className="text-brand-700 group-hover:underline truncate max-w-[16rem]">
                              {j.name}
                            </span>
                            <Badge tone={STATUS_TONE[j.status]}>
                              {STATUS_LABEL[j.status]}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
