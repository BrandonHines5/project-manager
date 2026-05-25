import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"

export function assigneeNamesFor(
  itemId: string,
  data: Pick<ScheduleData, "assignments" | "profiles" | "companies">
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
    }
  }
  return names
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
