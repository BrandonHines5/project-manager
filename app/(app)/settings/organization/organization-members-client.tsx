"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { UserMinus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  removeOrgMember,
  setOrgMemberRole,
  type OrgMemberRole,
} from "@/app/actions/org"

export type OrgMemberRow = {
  profile_id: string
  member_role: OrgMemberRole
  full_name: string | null
  email: string | null
}

const ROLE_LABEL: Record<OrgMemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

/**
 * Members roster on /settings/organization. The controls mirror the 0110 RPC
 * matrix for UX only — the database enforces it: owners manage everyone,
 * admins manage non-owners, and the last owner can't be demoted or removed.
 */
export function OrganizationMembersClient({
  orgId,
  callerId,
  callerRole,
  members,
}: {
  orgId: string
  callerId: string
  callerRole: OrgMemberRole
  members: OrgMemberRow[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const ownerCount = members.filter((m) => m.member_role === "owner").length

  function changeRole(member: OrgMemberRow, role: OrgMemberRole) {
    setConfirmingId(null)
    startTransition(async () => {
      const result = await setOrgMemberRole({
        orgId,
        profileId: member.profile_id,
        role,
      })
      if (result.ok) {
        toast.success("Member role updated")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't update the member role.")
      }
    })
  }

  function remove(member: OrgMemberRow) {
    if (confirmingId !== member.profile_id) {
      setConfirmingId(member.profile_id)
      return
    }
    setConfirmingId(null)
    startTransition(async () => {
      const result = await removeOrgMember({
        orgId,
        profileId: member.profile_id,
      })
      if (result.ok) {
        toast.success("Member removed")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't remove the member.")
      }
    })
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <div>
        <div className="text-sm font-medium">Members</div>
        <div className="text-xs text-muted">
          Owners manage everyone; admins manage members and other admins. New
          people join through Team invites and client invites — this list
          controls organization roles, not app accounts.
        </div>
      </div>
      <ul className="divide-y divide-border">
        {members.map((m) => {
          const isSelf = m.profile_id === callerId
          const isOwnerRow = m.member_role === "owner"
          const lastOwner = isOwnerRow && ownerCount <= 1
          // Admins can't touch owner rows at all; owners can do anything
          // except break the last-owner invariant.
          const canManage = callerRole === "owner" || !isOwnerRow
          const roleOptions: OrgMemberRole[] =
            callerRole === "owner"
              ? ["owner", "admin", "member"]
              : ["admin", "member"]
          return (
            <li
              key={m.profile_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {m.full_name || m.email || "Unnamed"}
                  {isSelf && <span className="text-muted font-normal"> (you)</span>}
                </div>
                {m.email && (
                  <div className="text-xs text-muted truncate">{m.email}</div>
                )}
              </div>
              {canManage ? (
                <select
                  value={m.member_role}
                  disabled={pending || lastOwner}
                  title={
                    lastOwner
                      ? "An organization must keep at least one owner."
                      : undefined
                  }
                  onChange={(e) =>
                    changeRole(m, e.target.value as OrgMemberRole)
                  }
                  className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50"
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge>{ROLE_LABEL[m.member_role]}</Badge>
              )}
              {canManage && !lastOwner && (
                <Button
                  type="button"
                  variant={confirmingId === m.profile_id ? "danger" : "ghost"}
                  size="sm"
                  disabled={pending}
                  onClick={() => remove(m)}
                >
                  <UserMinus className="h-3.5 w-3.5 mr-1" />
                  {confirmingId === m.profile_id ? "Confirm remove" : "Remove"}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
