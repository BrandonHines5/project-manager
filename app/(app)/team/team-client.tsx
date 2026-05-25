"use client"

import { useState, useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Search, UserCog } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Field, Input, Select } from "@/components/ui/input"
import { Avatar } from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { updateProfile, type UpdateProfileInputT } from "@/app/actions/team"
import type { Tables, Enums } from "@/lib/db/types"

export function TeamClient({
  profiles,
  companies,
}: {
  profiles: Tables<"profiles">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
}) {
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState<"all" | Enums<"user_role">>("all")
  const [editing, setEditing] = useState<Tables<"profiles"> | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return profiles
      .filter((p) => roleFilter === "all" || p.role === roleFilter)
      .filter((p) => {
        if (!q) return true
        return (
          p.full_name.toLowerCase().includes(q) ||
          (p.email ?? "").toLowerCase().includes(q)
        )
      })
  }, [profiles, search, roleFilter])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted">
            Everyone with an account. New users sign up themselves at
            /login (every signup defaults to staff — change their role here).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={roleFilter}
            onChange={(e) =>
              setRoleFilter(e.target.value as "all" | Enums<"user_role">)
            }
            className="w-auto"
          >
            <option value="all">All roles</option>
            <option value="staff">Staff</option>
            <option value="trade">Trades</option>
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
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-10 w-10" />}
          title={
            profiles.length === 0
              ? "No accounts yet"
              : "No matches"
          }
          description={
            profiles.length === 0
              ? "Sign up at /login first to create your account."
              : "Try different search terms."
          }
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Email</th>
                <th className="text-left px-4 py-2.5 w-24">Role</th>
                <th className="text-left px-4 py-2.5">Company</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((p) => {
                const company = companies.find((c) => c.id === p.company_id)
                return (
                  <tr
                    key={p.id}
                    onClick={() => setEditing(p)}
                    className="hover:bg-background/40 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={p.full_name || p.email || "?"} size="sm" />
                        <span className="font-medium">
                          {p.full_name || (
                            <span className="text-muted italic">no name</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{p.email}</td>
                    <td className="px-4 py-3">
                      <RoleBadge role={p.role} />
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {company?.name || "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditDialog
          key={editing.id}
          profile={editing}
          companies={companies}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function RoleBadge({ role }: { role: Enums<"user_role"> }) {
  if (role === "staff") return <Badge tone="brand">Staff</Badge>
  if (role === "trade") return <Badge tone="warning">Trade</Badge>
  return <Badge tone="info">Client</Badge>
}

function EditDialog({
  profile,
  companies,
  onClose,
}: {
  profile: Tables<"profiles">
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fullName, setFullName] = useState(profile.full_name)
  const [role, setRole] = useState<Enums<"user_role">>(profile.role)
  const [companyId, setCompanyId] = useState(profile.company_id ?? "")
  const [phone, setPhone] = useState(profile.phone ?? "")

  function submit() {
    if (!fullName.trim()) {
      toast.error("Name is required")
      return
    }
    const payload: UpdateProfileInputT = {
      id: profile.id,
      full_name: fullName.trim(),
      role,
      company_id: companyId || null,
      phone: phone || null,
    }
    startTransition(async () => {
      try {
        await updateProfile(payload)
        toast.success("Saved")
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>{profile.full_name || profile.email}</DialogTitle>
            <DialogDescription>{profile.email}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Full name">
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as Enums<"user_role">)}
            >
              <option value="staff">Staff — full access</option>
              <option value="trade">
                Trade — only schedule items assigned to them
              </option>
              <option value="client">
                Client — only their project (read-only)
              </option>
            </Select>
          </Field>
          <Field label="Company">
            <Select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              <option value="">— none —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.type}
                  {c.trade_category ? ` (${c.trade_category})` : ""}
                </option>
              ))}
            </Select>
            {role === "trade" && (
              <p className="text-xs text-muted mt-1">
                Linking a trade user to a sub/vendor company lets them see
                schedule items assigned to that company too.
              </p>
            )}
          </Field>
          <Field label="Phone">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
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
