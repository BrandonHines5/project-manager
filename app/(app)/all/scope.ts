import { createSupabaseServerClient } from "@/lib/supabase/server"
import { OPEN_STATUSES } from "@/lib/project-status"
import { parseProjectIds } from "./parse-ids"

export type ScopeProject = {
  id: string
  name: string
  project_number: string
}

export type AllScope = {
  projects: ScopeProject[]
  // True when the user narrowed the view via ?ids= (jobs-list checkboxes);
  // false when we defaulted to every open job.
  explicit: boolean
}

/**
 * Resolve which jobs an /all/* page spans: the explicit ?ids= selection when
 * present, otherwise every open, non-template job the viewer can see. Both
 * queries are RLS-scoped, so clients/trades only ever aggregate their own
 * projects.
 */
export async function resolveAllScope(
  rawIds: string | string[] | undefined
): Promise<AllScope> {
  const ids = parseProjectIds(rawIds)
  const supabase = await createSupabaseServerClient()

  let query = supabase
    .from("projects")
    .select("id, name, project_number, is_template")
    .order("project_number", { ascending: false })
  query = ids.length
    ? query.in("id", ids)
    : query.in("status", [...OPEN_STATUSES])
  const { data, error } = await query
  if (error) throw new Error(error.message)

  // Templates aren't real jobs — keep them out of aggregate views. Both the
  // is_template flag and the project-number convention count (the sidebar
  // uses the latter).
  const projects = (data ?? []).filter(
    (p) =>
      !p.is_template && !p.project_number.toUpperCase().startsWith("TEMPLATE")
  )
  return { projects, explicit: ids.length > 0 }
}

// "across 12 open jobs" / "across 3 selected jobs" — shared by the scope
// line at the top of each /all page.
export function scopeLabel(scope: AllScope): string {
  const n = scope.projects.length
  return `${n} ${scope.explicit ? "selected" : "open"} job${n === 1 ? "" : "s"}`
}
