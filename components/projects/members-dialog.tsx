"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Users, X, Plus, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Select, Label } from "@/components/ui/input"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { roleLabel } from "@/lib/utils"
import {
  addProjectMember,
  removeProjectMember,
} from "@/app/actions/project-members"
import { inviteProjectClients } from "@/app/actions/client-invites"

type MemberProfile = {
  id: string
  full_name: string
  email: string
  role: "staff" | "trade" | "client"
}
type Member = {
  profile_id: string
  role_on_project: string | null
}

export function MembersButton({
  projectId,
  members,
  profiles,
}: {
  projectId: string
  members: Member[]
  profiles: MemberProfile[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground cursor-pointer"
        title="Manage members"
      >
        <Users className="h-3.5 w-3.5" /> {members.length} member
        {members.length === 1 ? "" : "s"}
      </button>
      {open && (
        <MembersDialog
          projectId={projectId}
          members={members}
          profiles={profiles}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function MembersDialog({
  projectId,
  members,
  profiles,
  onClose,
}: {
  projectId: string
  members: Member[]
  profiles: MemberProfile[]
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedProfile, setSelectedProfile] = useState("")
  const [roleOnProject, setRoleOnProject] = useState("")

  const memberMap = new Map(members.map((m) => [m.profile_id, m]))
  // Staff already have access to all projects via is_staff() RLS — adding
  // them as project_members is a no-op and just clutters the picker. Filter
  // them out of the candidate list.
  const candidateProfiles = profiles.filter(
    (p) => !memberMap.has(p.id) && p.role !== "staff"
  )

  function handleAdd() {
    if (!selectedProfile) return
    startTransition(async () => {
      try {
        await addProjectMember({
          project_id: projectId,
          profile_id: selectedProfile,
          role_on_project: roleOnProject || null,
        })
        toast.success("Added")
        setSelectedProfile("")
        setRoleOnProject("")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not add")
      }
    })
  }

  function handleRemove(profileId: string) {
    if (!confirm("Remove this member from the project?")) return
    startTransition(async () => {
      try {
        await removeProjectMember({
          project_id: projectId,
          profile_id: profileId,
        })
        toast.success("Removed")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not remove")
      }
    })
  }

  function handleInvite() {
    startTransition(async () => {
      try {
        const r = await inviteProjectClients(projectId)
        if (r.sent > 0) {
          toast.success(
            `Sent ${r.sent} client invite${r.sent === 1 ? "" : "s"}.` +
              (r.alreadyJoined
                ? ` ${r.alreadyJoined} already joined.`
                : "")
          )
        } else if (r.alreadyJoined > 0) {
          toast.success("All client contacts have already joined.")
        } else {
          toast.error("No invites were sent.")
        }
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not send invites")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>Project members</DialogTitle>
            <DialogDescription>
              Add trades or clients here so they can see this project.
              (Team members have access to all projects automatically.)
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="rounded-md border border-border bg-background/40 p-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Client portal</p>
              <p className="text-xs text-muted">
                Email this job&rsquo;s client contacts a link to set up their own
                login. They accept a disclaimer, choose a password, and are added
                here automatically.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={handleInvite}
              disabled={pending}
              className="shrink-0"
            >
              <Mail className="h-4 w-4" /> Invite clients
            </Button>
          </div>
          <div>
            <Label>Current members</Label>
            {members.length === 0 ? (
              <p className="text-xs text-muted mt-1">No members yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-border border border-border rounded-md">
                {members.map((m) => {
                  const p = profiles.find((x) => x.id === m.profile_id)
                  if (!p) return null
                  return (
                    <li
                      key={m.profile_id}
                      className="px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={p.full_name || p.email} size="sm" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {p.full_name || p.email}
                          </div>
                          <div className="text-xs text-muted truncate">
                            {p.email}
                            {m.role_on_project && (
                              <span className="ml-2">· {m.role_on_project}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <RoleBadge role={p.role} />
                        <button
                          type="button"
                          onClick={() => handleRemove(m.profile_id)}
                          className="text-muted hover:text-danger cursor-pointer"
                          title="Remove"
                          aria-label={`Remove ${p.full_name || p.email} from project`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div>
            <Label>Add member</Label>
            <div className="mt-1 grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
              <Select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
              >
                <option value="">Choose user…</option>
                {candidateProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {(p.full_name || p.email) + ` · ${roleLabel(p.role)}`}
                  </option>
                ))}
              </Select>
              <Field>
                <Input
                  placeholder="Role on project (optional)"
                  value={roleOnProject}
                  onChange={(e) => setRoleOnProject(e.target.value)}
                />
              </Field>
              <Button
                type="button"
                onClick={handleAdd}
                disabled={pending || !selectedProfile}
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {candidateProfiles.length === 0 && (
              <p className="text-xs text-muted mt-1">
                Every existing user is already a member. New users sign up at
                /login first.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RoleBadge({ role }: { role: "staff" | "trade" | "client" }) {
  if (role === "staff") return <Badge tone="brand">Team</Badge>
  if (role === "trade") return <Badge tone="warning">Trade</Badge>
  return <Badge tone="info">Client</Badge>
}
