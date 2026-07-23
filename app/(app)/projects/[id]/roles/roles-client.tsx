"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Pencil, Plus, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody } from "@/components/ui/card"
import { Field, Input, Select } from "@/components/ui/input"
import {
  SearchableSelect,
  type SearchableOption,
} from "@/components/ui/searchable-select"
import { roleLabel } from "@/lib/utils"
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
  saveRoleAssignment,
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
type ScheduleItem = {
  id: string
  title: string
  kind: string
  milestone: string | null
}
type RoleAssignment = { role_id: string; schedule_item_id: string }

function normalizeRoleKind(kind: string): RoleKind {
  return (["staff", "company", "any"].includes(kind) ? kind : "any") as RoleKind
}

// Flat people+companies list for the assignee pickers, preferred group first.
// Values keep the `p:{id}` / `c:{id}` encoding setProjectRole expects.
function assigneeOptions(
  people: Profile[],
  companies: Company[],
  peopleFirst: boolean
): SearchableOption[] {
  const peopleOpts = people.map((p) => ({
    value: `p:${p.id}`,
    label: p.full_name || p.email || "",
    hint: roleLabel(p.role),
  }))
  const companyOpts = companies.map((c) => ({
    value: `c:${c.id}`,
    label: c.name,
    hint: c.trade_category ?? "company",
  }))
  return peopleFirst
    ? [...peopleOpts, ...companyOpts]
    : [...companyOpts, ...peopleOpts]
}

export function RolesClient({
  projectId,
  isTemplate,
  projectManager,
  roles,
  members,
  profiles,
  companies,
  scheduleItems,
  roleAssignments,
}: {
  projectId: string
  isTemplate: boolean
  projectManager: string | null
  roles: Role[]
  members: Member[]
  profiles: Profile[]
  companies: Company[]
  scheduleItems: ScheduleItem[]
  roleAssignments: RoleAssignment[]
}) {
  const router = useRouter()
  // The role dialog handles both a freshly-added role (isNew) and Edit; it
  // fills the role on this job and assigns it to work / to-do items.
  const [dialog, setDialog] = useState<{ role: Role; isNew: boolean } | null>(
    null
  )

  const memberByRole = useMemo(() => {
    const m = new Map<string, Member>()
    for (const row of members) m.set(row.role_id, row)
    return m
  }, [members])

  // role_id -> the schedule items it's currently assigned to on this job, so
  // the dialog opens with those pre-checked.
  const itemsByRole = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const a of roleAssignments) {
      const arr = m.get(a.role_id)
      if (arr) arr.push(a.schedule_item_id)
      else m.set(a.role_id, [a.schedule_item_id])
    }
    return m
  }, [roleAssignments])

  // Group by kind — staff first, then subs/vendors, then "anyone" — and
  // alphabetize within each group so a long role list is scannable.
  const groups = useMemo(() => {
    const byKind = (k: RoleKind) =>
      roles
        .filter((r) => normalizeRoleKind(r.kind) === k)
        .sort((a, b) => a.name.localeCompare(b.name))
    return (
      [
        { key: "staff", label: "Team", roles: byKind("staff") },
        { key: "company", label: "Subs / vendors", roles: byKind("company") },
        { key: "any", label: "Anyone", roles: byKind("any") },
      ] as const
    ).filter((g) => g.roles.length > 0)
  }, [roles])

  // Refresh on every close so the list reflects a save/delete — and so a role
  // that was just added shows up even if the dialog is cancelled.
  function closeDialog() {
    setDialog(null)
    router.refresh()
  }

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
            <div>
              {groups.map((group) => (
                <div key={group.key}>
                  <div className="px-4 py-1.5 bg-background/60 border-b border-border text-[11px] font-medium uppercase tracking-wide text-muted first:rounded-t-md">
                    {group.label}
                  </div>
                  <ul className="divide-y divide-border border-b border-border last:border-b-0">
                    {group.roles.map((role) => (
                      <RoleRow
                        key={role.id}
                        projectId={projectId}
                        role={role}
                        member={memberByRole.get(role.id) ?? null}
                        itemCount={itemsByRole.get(role.id)?.length ?? 0}
                        profiles={profiles}
                        companies={companies}
                        projectManager={projectManager}
                        onEdit={() => setDialog({ role, isNew: false })}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <AddRoleForm onAdded={(role) => setDialog({ role, isNew: true })} />

      {dialog && (
        <RoleDialog
          key={dialog.role.id}
          role={dialog.role}
          isNew={dialog.isNew}
          projectId={projectId}
          member={memberByRole.get(dialog.role.id) ?? null}
          assignedItemIds={itemsByRole.get(dialog.role.id) ?? []}
          profiles={profiles}
          companies={companies}
          scheduleItems={scheduleItems}
          onClose={closeDialog}
        />
      )}
    </div>
  )
}

function RoleRow({
  projectId,
  role,
  member,
  itemCount,
  profiles,
  companies,
  projectManager,
  onEdit,
}: {
  projectId: string
  role: Role
  member: Member | null
  itemCount: number
  profiles: Profile[]
  companies: Company[]
  projectManager: string | null
  onEdit: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const kind = normalizeRoleKind(role.kind)

  // People = non-client profiles; companies = already filtered to non-client.
  // Both alphabetical (roles arrive in position order elsewhere; these lists
  // come pre-sorted from the query but we keep the render stable).
  const people = useMemo(
    () => profiles.filter((p) => p.role !== "client"),
    [profiles]
  )
  // `kind` is advisory: it only orders the option groups (the preferred kind
  // first) — it never hides a valid target. setProjectRole accepts either a
  // profile or a company for any role, so both groups are always offered;
  // hiding one would block valid mappings and could strand a stored value
  // that has no matching option.
  const peopleFirst = kind !== "company"

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
        <span className="font-medium">{role.name}</span>
        {itemCount > 0 && (
          <span className="ml-2 text-xs text-muted">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        )}
        {pmHint && <p className="text-xs text-muted mt-0.5">{pmHint}</p>}
      </div>
      <div className="w-full sm:w-64">
        <SearchableSelect
          value={value}
          disabled={pending}
          onChange={change}
          options={assigneeOptions(people, companies, peopleFirst)}
          placeholder="— Unassigned —"
          ariaLabel={`Assignee for ${role.name}`}
        />
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-muted hover:text-foreground p-1.5 cursor-pointer shrink-0"
        title="Edit role / assign to schedule items"
      >
        <Pencil className="h-4 w-4" />
      </button>
    </li>
  )
}

function AddRoleForm({ onAdded }: { onAdded: (role: Role) => void }) {
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
      // Open the assignment dialog for the just-added role so the assignee and
      // its work / to-do items can be set right away.
      onAdded({
        id: res.role.id,
        name: res.role.name,
        kind: res.role.kind,
        position: res.role.position,
      })
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
            <option value="staff">Team</option>
            <option value="company">Sub / vendor</option>
          </Select>
        </Field>
        <Button type="button" onClick={submit} disabled={pending}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      <p className="text-xs text-muted mt-1">
        Roles are shared across all projects and templates. After you add one, a
        box opens to assign it to a person or sub and to any work or to-do
        items. &ldquo;Usually filled by&rdquo; just sorts the assignee list.
      </p>
    </div>
  )
}

/**
 * One dialog for both the just-added role (isNew) and Edit. It renames /
 * re-kinds the role, fills it on this job, and reconciles which work / to-do
 * items it's assigned to — all persisted on Save via updateRole +
 * saveRoleAssignment.
 */
function RoleDialog({
  role,
  isNew,
  projectId,
  member,
  assignedItemIds,
  profiles,
  companies,
  scheduleItems,
  onClose,
}: {
  role: Role
  isNew: boolean
  projectId: string
  member: Member | null
  assignedItemIds: string[]
  profiles: Profile[]
  companies: Company[]
  scheduleItems: ScheduleItem[]
  onClose: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [name, setName] = useState(role.name)
  const [kind, setKind] = useState<RoleKind>(normalizeRoleKind(role.kind))
  const [target, setTarget] = useState(
    member?.profile_id
      ? `p:${member.profile_id}`
      : member?.company_id
        ? `c:${member.company_id}`
        : ""
  )
  const [selectedItems, setSelectedItems] = useState<Set<string>>(
    new Set(assignedItemIds)
  )
  const [itemFilter, setItemFilter] = useState("")

  // People = non-client profiles; companies already exclude clients. Both
  // alphabetical; `kind` only orders which group comes first.
  const people = useMemo(
    () =>
      profiles
        .filter((p) => p.role !== "client")
        .sort((a, b) =>
          (a.full_name || a.email || "").localeCompare(
            b.full_name || b.email || ""
          )
        ),
    [profiles]
  )
  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies]
  )
  const peopleFirst = kind !== "company"

  const sortedItems = useMemo(
    () => [...scheduleItems].sort((a, b) => a.title.localeCompare(b.title)),
    [scheduleItems]
  )
  const filteredItems = useMemo(() => {
    const q = itemFilter.trim().toLowerCase()
    return q
      ? sortedItems.filter((i) => i.title.toLowerCase().includes(q))
      : sortedItems
  }, [sortedItems, itemFilter])

  const selectedCount = selectedItems.size

  function toggleItem(id: string) {
    setSelectedItems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Role name is required")
      return
    }
    const ids = Array.from(selectedItems)
    startTransition(async () => {
      // Only touch the org-wide catalog row when the name/kind actually
      // changed — avoids a needless write (and revalidation) on every save.
      if (trimmed !== role.name || kind !== normalizeRoleKind(role.kind)) {
        const up = await updateRole({ id: role.id, name: trimmed, kind })
        if (!up.ok) {
          toast.error(up.error)
          return
        }
      }
      const res = await saveRoleAssignment({
        project_id: projectId,
        role_id: role.id,
        target,
        schedule_item_ids: ids,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const bits: string[] = []
      if (res.added > 0) bits.push(`${res.added} added`)
      if (res.removed > 0) bits.push(`${res.removed} removed`)
      if (res.skipped > 0) bits.push(`${res.skipped} skipped`)
      const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : ""
      toast.success(`${isNew ? `Added role "${trimmed}"` : "Saved"}${suffix}`)
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
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !pending && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>{isNew ? "Assign role" : "Edit role"}</DialogTitle>
            <DialogDescription>
              {isNew ? (
                <>
                  &ldquo;{role.name}&rdquo; was added. Choose who fills it on
                  this job and which work or to-do items it covers — or leave it
                  and set this later.
                </>
              ) : (
                <>
                  Set who fills this role on this job and which work or to-do
                  items it&apos;s assigned to. Renaming changes the role
                  everywhere it&apos;s used, across all projects and templates.
                </>
              )}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Role name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={!isNew}
              />
            </Field>
            <Field label="Usually filled by">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as RoleKind)}
              >
                <option value="any">Anyone</option>
                <option value="staff">Team</option>
                <option value="company">Sub / vendor</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Assign to (this job)"
            hint="Maps the role to a person or sub/vendor for this job."
          >
            <SearchableSelect
              value={target}
              onChange={setTarget}
              options={assigneeOptions(people, sortedCompanies, peopleFirst)}
              placeholder="— Unassigned —"
              ariaLabel="Assign role to"
            />
          </Field>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">
                Assign to work / to-do items
              </span>
              {sortedItems.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  {selectedCount > 0 && (
                    <span className="text-muted">{selectedCount} selected</span>
                  )}
                  <button
                    type="button"
                    className="text-brand-600 hover:text-brand-700 cursor-pointer"
                    onClick={() =>
                      // Union the currently-shown (filtered) items into the
                      // selection so this respects an active filter and never
                      // drops items already checked.
                      setSelectedItems(
                        (prev) =>
                          new Set([...prev, ...filteredItems.map((i) => i.id)])
                      )
                    }
                  >
                    {itemFilter.trim() ? "Select filtered" : "Select all"}
                  </button>
                  {selectedCount > 0 && (
                    <button
                      type="button"
                      className="text-muted hover:text-foreground cursor-pointer"
                      onClick={() => setSelectedItems(new Set())}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
            {sortedItems.length === 0 ? (
              <p className="text-xs text-muted">
                No schedule items on this job yet.
              </p>
            ) : (
              <>
                {sortedItems.length > 8 && (
                  <Input
                    value={itemFilter}
                    onChange={(e) => setItemFilter(e.target.value)}
                    placeholder="Filter schedule items…"
                    className="mb-1.5 h-8"
                  />
                )}
                <div className="max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border">
                  {filteredItems.length === 0 ? (
                    <p className="text-xs text-muted px-3 py-2">
                      No items match &ldquo;{itemFilter}&rdquo;.
                    </p>
                  ) : (
                    filteredItems.map((item) => (
                      <label
                        key={item.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-background/60"
                      >
                        <input
                          type="checkbox"
                          checked={selectedItems.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          className="h-4 w-4 rounded border-border-strong text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500/40"
                        />
                        <span className="min-w-0 truncate">{item.title}</span>
                        {item.milestone ? (
                          <span className="ml-auto shrink-0 text-[11px] text-muted">
                            Milestone
                          </span>
                        ) : item.kind === "todo" ? (
                          <span className="ml-auto shrink-0 text-[11px] text-muted">
                            To-do
                          </span>
                        ) : null}
                      </label>
                    ))
                  )}
                </div>
              </>
            )}
            <p className="text-xs text-muted mt-1">
              The role is assigned to each checked item; it resolves to whoever
              fills the role on this job.
            </p>
          </div>

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
              <Button
                type="button"
                variant="danger"
                onClick={remove}
                disabled={pending}
              >
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
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={pending}
              >
                {isNew ? "Skip" : "Cancel"}
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
