"use client"

import { useState, useMemo, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Search,
  UserCog,
  UserPlus,
  Trash2,
  Copy,
  RefreshCw,
  KeyRound,
  Bell,
  BellOff,
} from "lucide-react"
import { cn } from "@/lib/utils"
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
import {
  updateProfile,
  inviteTeamMember,
  deleteTeamMember,
  resetTeamMemberPassword,
  setMemberNotifications,
  type UpdateProfileInputT,
  type InviteTeamMemberInputT,
} from "@/app/actions/team"
import type { Tables, Enums } from "@/lib/db/types"

export function TeamClient({
  profiles,
  companies,
  currentUserId,
}: {
  profiles: Tables<"profiles">[]
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  currentUserId: string
}) {
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState<"all" | Enums<"user_role">>("all")
  const [editing, setEditing] = useState<Tables<"profiles"> | null>(null)
  const [inviting, setInviting] = useState(false)

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
            Add team members, trades, or clients. New users get a temporary password
            you share with them — they can change it after signing in.
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
            <option value="staff">Team</option>
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
          <Button onClick={() => setInviting(true)}>
            <UserPlus className="h-4 w-4" />
            Add team member
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-10 w-10" />}
          title={profiles.length === 0 ? "No accounts yet" : "No matches"}
          description={
            profiles.length === 0
              ? 'Click "Add team member" to invite someone.'
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
                <th className="text-right px-4 py-2.5 w-36">Notifications</th>
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
                    <td className="px-4 py-3 text-right">
                      <NotifyToggle profile={p} />
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
          currentUserId={currentUserId}
          onClose={() => setEditing(null)}
        />
      )}

      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  )
}

function RoleBadge({ role }: { role: Enums<"user_role"> }) {
  if (role === "staff") return <Badge tone="brand">Team</Badge>
  if (role === "trade") return <Badge tone="warning">Trade</Badge>
  return <Badge tone="info">Client</Badge>
}

// Per-member master switch for all site notifications (in-app + email). Lives
// in its own column so staff can flip it without opening the edit dialog —
// stopPropagation keeps the row's click-to-edit from firing.
function NotifyToggle({ profile }: { profile: Tables<"profiles"> }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const enabled = profile.notifications_enabled
  const who = profile.full_name || profile.email || "team member"

  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    startTransition(async () => {
      try {
        await setMemberNotifications({ id: profile.id, enabled: !enabled })
        toast.success(
          enabled
            ? `Notifications muted for ${profile.full_name || profile.email}`
            : `Notifications on for ${profile.full_name || profile.email}`
        )
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Update failed")
      }
    })
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      role="switch"
      aria-checked={enabled}
      aria-label={`Notifications for ${who}: ${enabled ? "on" : "off"}`}
      title={
        enabled
          ? "All notifications on — click to mute this person"
          : "Notifications muted — click to turn back on"
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50",
        enabled
          ? "border-border-strong text-foreground hover:bg-background"
          : "border-danger/40 bg-danger/5 text-danger hover:bg-danger/10"
      )}
    >
      {enabled ? (
        <Bell className="h-3.5 w-3.5" />
      ) : (
        <BellOff className="h-3.5 w-3.5" />
      )}
      {enabled ? "On" : "Off"}
    </button>
  )
}

function EditDialog({
  profile,
  companies,
  currentUserId,
  onClose,
}: {
  profile: Tables<"profiles">
  companies: Pick<Tables<"companies">, "id" | "name" | "type" | "trade_category">[]
  currentUserId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [deleting, startDelete] = useTransition()
  const [resettingPw, startResetPw] = useTransition()
  const [fullName, setFullName] = useState(profile.full_name)
  const [role, setRole] = useState<Enums<"user_role">>(profile.role)
  const [companyId, setCompanyId] = useState(profile.company_id ?? "")
  const [phone, setPhone] = useState(profile.phone ?? "")
  const [emailDigestPref, setEmailDigestPref] = useState<
    Enums<"email_digest_pref">
  >(profile.email_digest_pref ?? "immediate")
  const [financialAccess, setFinancialAccess] = useState(
    profile.financial_access ?? false
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  // After a successful reset, the new temp password is shown inline so staff
  // can copy & share it. Stored only in component state — never persisted.
  const [resetPassword, setResetPassword] = useState<string | null>(null)

  const isSelf = profile.id === currentUserId

  function doResetPassword() {
    startResetPw(async () => {
      try {
        const { password } = await resetTeamMemberPassword(profile.id)
        setResetPassword(password)
        toast.success("New password generated. Share it securely.")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Reset failed")
      }
    })
  }

  function copyResetPassword() {
    if (!resetPassword) return
    navigator.clipboard.writeText(resetPassword).then(
      () => toast.success("Password copied"),
      () => toast.error("Copy failed")
    )
  }

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
      email_digest_pref: emailDigestPref,
      financial_access: financialAccess,
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

  function doDelete() {
    startDelete(async () => {
      try {
        await deleteTeamMember(profile.id)
        toast.success(`Deleted ${profile.full_name || profile.email}`)
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed")
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
              <option value="staff">Team — full access</option>
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
          <Field
            label="Email notifications"
            hint="Immediate: one email per event. Daily digest: a single roll-up each morning. Off: in-app bell only."
          >
            <Select
              value={emailDigestPref}
              onChange={(e) =>
                setEmailDigestPref(e.target.value as Enums<"email_digest_pref">)
              }
            >
              <option value="immediate">Immediate (per event)</option>
              <option value="daily">Daily digest</option>
              <option value="off">Off</option>
            </Select>
          </Field>

          {role === "staff" && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={financialAccess}
                onChange={(e) => setFinancialAccess(e.target.checked)}
                className="h-4 w-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">Financial access</span>
                <span className="block text-xs text-muted mt-0.5">
                  Shows the Contract value, Cost growth, and per-row
                  financial columns on the /projects dashboard. Keep off
                  for team members who shouldn&rsquo;t see contract totals.
                </span>
              </span>
            </label>
          )}

          <div className="rounded-md border border-border-strong bg-background/40 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Password</p>
                <p className="text-xs text-muted">
                  Generate a new temporary password and share it with the user
                  — they should change it after signing in.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={doResetPassword}
                disabled={pending || deleting || resettingPw}
              >
                <KeyRound className="h-4 w-4" />
                {resettingPw ? "Resetting…" : "Reset password"}
              </Button>
            </div>
            {resetPassword && (
              <div className="flex gap-2 pt-1">
                <Input
                  value={resetPassword}
                  readOnly
                  className="font-mono"
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyResetPassword}
                  title="Copy"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {confirmDelete && (
            <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm space-y-2">
              <p className="font-medium text-foreground">
                Delete {profile.full_name || profile.email}?
              </p>
              <p className="text-muted text-xs">
                This removes their account and signs them out. Their authored
                content (decisions, job logs, comments) is preserved with the
                author shown as removed.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={doDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            disabled={pending || deleting || isSelf || confirmDelete}
            className="text-danger hover:bg-danger/10"
            title={isSelf ? "You can't delete your own account" : undefined}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || deleting}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function generatePassword() {
  // 14 chars, A-Z a-z 0-9 plus a symbol from a safe set so password managers don't
  // mis-handle it. Uses crypto.getRandomValues so it's not Math.random-predictable.
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  const symbols = "!@#$%&*?"
  const buf = new Uint32Array(14)
  crypto.getRandomValues(buf)
  let out = ""
  for (let i = 0; i < 13; i++) out += alphabet[buf[i] % alphabet.length]
  out += symbols[buf[13] % symbols.length]
  return out
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Enums<"user_role">>("staff")
  const [password, setPassword] = useState(() => generatePassword())

  function submit() {
    if (!fullName.trim()) {
      toast.error("Name is required")
      return
    }
    if (!email.trim()) {
      toast.error("Email is required")
      return
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }
    const payload: InviteTeamMemberInputT = {
      full_name: fullName.trim(),
      email: email.trim(),
      role,
      password,
    }
    startTransition(async () => {
      try {
        await inviteTeamMember(payload)
        toast.success(
          `${payload.full_name} added. Share their temp password securely.`
        )
        router.refresh()
        onClose()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add user")
      }
    })
  }

  function copyPassword() {
    navigator.clipboard.writeText(password).then(
      () => toast.success("Password copied"),
      () => toast.error("Copy failed")
    )
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>Add team member</DialogTitle>
            <DialogDescription>
              Creates a confirmed account with the temp password below.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Full name">
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Builder"
              autoFocus
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@hineshomes.com"
              autoComplete="off"
            />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as Enums<"user_role">)}
            >
              <option value="staff">Team — full access</option>
              <option value="trade">
                Trade — only schedule items assigned to them
              </option>
              <option value="client">
                Client — only their project (read-only)
              </option>
            </Select>
          </Field>
          <Field label="Temporary password">
            <div className="flex gap-2">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setPassword(generatePassword())}
                title="Regenerate"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={copyPassword}
                title="Copy"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted mt-1">
              Share this with the new user — they should change it after
              signing in.
            </p>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
