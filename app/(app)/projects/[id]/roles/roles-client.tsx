"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Pencil, Plus, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardBody } from "@/components/ui/card"
import { Field, Input, Select } from "@/components/ui/input"
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
  createRole,
  updateRole,
  deleteRole,
  setProjectRole,
} from "@/app/actions/roles"

type RoleKind = "staff" | "company" | "any"

type Role = { id: string; name: string; kind: string; position: number }
type Member = {
  role_id: string
  profile_id: string | null
  company_id: string | null
}
type Profile = {
  id: string
  full_name: string
  email: string | null
  role: string
}
type Company = {
  id: string
  name: string
  type: string
  trade_category: string | null
}

const KIND_LABEL: Record<RoleKind, string> = {
  staff: "Staff",
  company: "Sub / vendor",
  any: "Anyone",
}

export function RolesClient({
  projectId,
  isTemplate,
  projectManager,
  roles,
  members,
  profiles,
  companies,
}: {
  projectId: string
  isTemplate: boolean
  projectManager: string | null
  roles: Role[]
  members: Member[]
  profiles: Profile[]
  companies: Company[]
}) {
  const [editing, setEditing] = useState<Role | null>(null)
  const memberByRole = useMemo(() => {
    const m = new Map<string, Member>()
    for (const row of members) m.set(row.role_id, row)
    return m
  }, [members])

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Roles</h2>
        <p className="text-sm text-muted mt-0.5">
          {isTemplate ? (
            <>
              On a template, assign schedule items to a role (e.g.{" "}
              <span className="font-medium">Footings Excavator</span>). When a
              job is created from this template you map each role to a real
              person or company here, and every item assigned to that role
              follows.
            </>
          ) : (
            <>
              Map each role to the person or company filling it on this job.
              Every schedule item assigned to a role shows the resolved name —
              change a mapping here and all of those items update at once.
            </>
          )}
        </p>
      </div>

      <Card>
        <CardBody className="p-0">
          {roles.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Users className="h-6 w-6 text-muted mx-auto mb-2" />
              <p className="text-sm text-muted">
                No roles yet. Add one below (e.g. &ldquo;Project Manager&rdquo;,
                &ldquo;Framer&rdquo;, &ldquo;Footings Excavator&rdquo;).
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {roles.map((role) => (
                <RoleRow
                  key={role.id}
                  projectId={projectId}
                  role={role}
                  member={memberByRole.get(role.id) ?? null}
                  profiles={profiles}
                  companies={companies}
                  projectManager={projectManager}
                  onEdit={() => setEditing(role)}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <AddRoleForm />

      {editing && (
        <EditRoleDialog role={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

function RoleRow({
  projectId,
  role,
  member,
  profiles,
  companies,
  projectManager,
  onEdit,
}: {
  projectId: string
  role: Role
  member: Member | null
  profiles: Profile[]
  companies: Company[]
  projectManager: string | null
  onEdit: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const kind = (["staff", "company", "any"].includes(role.kind)
    ? role.kind
    : "any") as RoleKind

  // People = non-client profiles; companies = already filtered to non-client.
  const people = useMemo(
    () => profiles.filter((p) => p.role !== "client"),
    [profiles]
  )
  // Show the kind-preferred group(s), but also always include the group that
  // matches the currently-assigned member — otherwise a role whose kind was
  // changed after assignment (e.g. a company filling a now-"staff" role) would
  // render with a value that has no matching option, showing a misleading
  // blank/Unassigned even though a member is stored.
  const showPeople = kind === "staff" || kind === "any" || !!member?.profile_id
  const showCompanies =
    kind === "company" || kind === "any" || !!member?.company_id

  const value = member?.profile_id
    ? `p:${member.profile_id}`
    : member?.company_id
      ? `c:${member.company_id}`
      : ""

  function change(target: string) {
    startTransition(async () => {
      const res = await setProjectRole({
        project_id: projectId,
        role_id: role.id,
        target,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      router.refresh()
    })
  }

  // Bridge to the dashboard PM: if this is the Project Manager role, it's
  // unfilled, and the dashboard handed us a PM name, surface it as a hint so
  // staff know who to pick.
  const pmHint =
    !member &&
    projectManager &&
    /project\s*manager/i.test(role.name)
      ? `Dashboard PM: ${projectManager}`
      : null

  return (
    <li className="px-4 py-3 flex items-center gap-3 flex-wrap sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{role.name}</span>
          <Badge tone="muted">{KIND_LABEL[kind]}</Badge>
        </div>
        {pmHint && <p className="text-xs text-muted mt-0.5">{pmHint}</p>}
      </div>
      <div className="w-full sm:w-64">
        <Select
          value={value}
          disabled={pending}
          onChange={(e) => change(e.target.value)}
          aria-label={`Assignee for ${role.name}`}
        >
          <option value="">— Unassigned —</option>
          {showPeople && people.length > 0 && (
            <optgroup label="People">
              {people.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>
                  {(p.full_name || p.email) + ` · ${p.role}`}
                </option>
              ))}
            </optgroup>
          )}
          {showCompanies && companies.length > 0 && (
            <optgroup label="Subs / vendors">
              {companies.map((c) => (
                <option key={c.id} value={`c:${c.id}`}>
                  {c.name}
                  {c.trade_category ? ` (${c.trade_category})` : ""}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-muted hover:text-foreground p-1.5 cursor-pointer shrink-0"
        title="Edit role"
      >
        <Pencil className="h-4 w-4" />
      </button>
    </li>
  )
}

function AddRoleForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [kind, setKind] = useState<RoleKind>("any")

  function submit() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Role name is required")
      return
    }
    startTransition(async () => {
      const res = await createRole({ name: trimmed, kind })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setName("")
      setKind("any")
      toast.success(`Added role "${res.role.name}"`)
      router.refresh()
    })
  }

  return (
    <div className="mt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted mb-2">
        Add a role
      </p>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <Field label="Role name" className="flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Footings Excavator"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>
        <Field label="Usually filled by" className="sm:w-44">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as RoleKind)}
          >
            <option value="any">Anyone</option>
            <option value="staff">Staff</option>
            <option value="company">Sub / vendor</option>
          </Select>
        </Field>
        <Button type="button" onClick={submit} disabled={pending}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      <p className="text-xs text-muted mt-1">
        Roles are shared across all projects and templates. &ldquo;Usually
        filled by&rdquo; just sorts the assignee list — you can still pick
        anyone.
      </p>
    </div>
  )
}

function EditRoleDialog({
  role,
  onClose,
}: {
  role: Role
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [name, setName] = useState(role.name)
  const [kind, setKind] = useState<RoleKind>(
    (["staff", "company", "any"].includes(role.kind)
      ? role.kind
      : "any") as RoleKind
  )

  function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Role name is required")
      return
    }
    startTransition(async () => {
      const res = await updateRole({ id: role.id, name: trimmed, kind })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      router.refresh()
      onClose()
    })
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteRole({ id: role.id })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(`Deleted role "${role.name}"`)
      router.refresh()
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !pending && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <div>
            <DialogTitle>Edit role</DialogTitle>
            <DialogDescription>
              Renaming changes this role everywhere it&apos;s used, across all
              projects and templates.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Role name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Usually filled by">
            <Select value={kind} onChange={(e) => setKind(e.target.value as RoleKind)}>
              <option value="any">Anyone</option>
              <option value="staff">Staff</option>
              <option value="company">Sub / vendor</option>
            </Select>
          </Field>
          {confirmingDelete && (
            <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
              <p className="font-medium text-danger">Delete this role?</p>
              <p className="text-xs text-muted mt-1">
                It will be removed from every project&apos;s role map and
                unassigned from any schedule items using it. This can&apos;t be
                undone.
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {confirmingDelete ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingDelete(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="button" variant="danger" onClick={remove} disabled={pending}>
                {pending ? "Deleting…" : "Delete role"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingDelete(true)}
                disabled={pending}
                className="mr-auto text-danger hover:bg-danger/10"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
