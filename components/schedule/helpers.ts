import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"

export function assigneeNamesFor(
  itemId: string,
  data: Pick<
    ScheduleData,
    "assignments" | "profiles" | "companies" | "roles" | "roleMembers"
  >
): string[] {
  const names: string[] = []
  for (const a of data.assignments) {
    if (a.schedule_item_id !== itemId) continue
    if (a.profile_id) {
      const p = data.profiles.find((x) => x.id === a.profile_id)
      if (p) names.push(p.full_name || p.email || "")
    } else if (a.company_id) {
      const c = data.companies.find((x) => x.id === a.company_id)
      if (c) names.push(c.name)
    } else if (a.role_id) {
      names.push(resolveRoleLabel(a.role_id, data))
    }
  }
  return names
}

/**
 * "Footings Excavator (Kauai Excavation)" for a role-based assignment, using
 * this project's role → assignee map. Falls back to "Role (unassigned)" when
 * the role isn't filled on this job, and to a bare label if the role catalog
 * row is missing (e.g. a just-deleted role). The avatar shows the role's
 * initials and the hover title shows the full label.
 */
export function resolveRoleLabel(
  roleId: string,
  data: Pick<ScheduleData, "profiles" | "companies" | "roles" | "roleMembers">
): string {
  const role = data.roles.find((r) => r.id === roleId)
  const roleName = role?.name ?? "Role"
  const member = data.roleMembers.find((m) => m.role_id === roleId)
  let who = "unassigned"
  if (member?.profile_id) {
    const p = data.profiles.find((x) => x.id === member.profile_id)
    if (p) who = p.full_name || p.email || "unassigned"
  } else if (member?.company_id) {
    const c = data.companies.find((x) => x.id === member.company_id)
    if (c) who = c.name
  }
  return `${roleName} (${who})`
}

export function childItemsOf(
  parentId: string,
  items: ScheduleData["items"]
) {
  return items.filter((i) => i.parent_id === parentId)
}

export function checklistFor(
  itemId: string,
  checklist: ScheduleData["checklist"]
) {
  return checklist.filter((c) => c.schedule_item_id === itemId)
}

export function predecessorsOf(
  itemId: string,
  preds: ScheduleData["predecessors"]
) {
  return preds.filter((p) => p.item_id === itemId)
}

export function delaysFor(
  itemId: string,
  delays: ScheduleData["delays"]
) {
  return delays.filter((d) => d.schedule_item_id === itemId)
}
