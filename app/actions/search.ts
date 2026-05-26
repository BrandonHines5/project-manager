"use server"

import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"

// One unified result type so the UI can render a mixed list with consistent
// affordances (icon, project crumb, link). The action picks `href` for each
// hit — RLS still does the access gating on every underlying query.
export type SearchResultType =
  | "project"
  | "work_item"
  | "todo"
  | "decision"
  | "decision_choice"
  | "daily_log"
  | "decision_comment"
  | "project_file"

export type SearchResult = {
  type: SearchResultType
  id: string
  project_id: string
  project_name: string | null
  project_number: string | null
  title: string
  snippet: string | null
  href: string
  meta: string | null
}

export type SearchScope = "current" | "all"

type SearchInput = {
  query: string
  scope: SearchScope
  // Only used when scope === "current". Ignored otherwise — RLS scopes the
  // result to projects the user can see anyway.
  project_id?: string | null
}

// Truncate a long body to a snippet. Tries to start the snippet near the
// match so the relevant text is visible.
function snippet(body: string | null | undefined, query: string): string | null {
  if (!body) return null
  const s = body.replace(/\s+/g, " ").trim()
  if (s.length <= 160) return s
  const idx = s.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return s.slice(0, 160) + "…"
  const start = Math.max(0, idx - 40)
  const end = Math.min(s.length, idx + query.length + 80)
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "")
}

// Build the `or(...)` PostgREST filter that runs ILIKE across several
// columns of the same table. Escapes commas / parens that would confuse
// the filter parser.
function ilikeOr(query: string, columns: string[]): string {
  const safe = query.replace(/[,()*]/g, " ").trim()
  if (!safe) return ""
  const pattern = `*${safe}*`
  return columns.map((c) => `${c}.ilike.${pattern}`).join(",")
}

const PER_TYPE_LIMIT = 8

export async function globalSearch(input: SearchInput): Promise<SearchResult[]> {
  await requireSession()
  const supabase = await createSupabaseServerClient()

  const query = input.query.trim()
  if (query.length < 2) return []

  // Helper: returns the projects.id filter when scoping to a single project,
  // or null when searching across everything the user can see.
  const projectFilter =
    input.scope === "current" && input.project_id ? input.project_id : null

  // Run all queries in parallel. Each query selects from one table and
  // pulls the parent project's name/number via the FK join. RLS already
  // gates access; we never see rows the caller can't read.
  const projectColumns = "id, name, project_number, address, client_name, notes"

  const projectsQ = supabase
    .from("projects")
    .select(projectColumns)
    .or(
      ilikeOr(query, [
        "name",
        "project_number",
        "address",
        "client_name",
        "notes",
      ])
    )
    .limit(PER_TYPE_LIMIT)
  const projectsP = projectFilter
    ? // "current project" scope: only return the current project as a project
      // result if its name/number matches — otherwise skip.
      projectsQ.eq("id", projectFilter)
    : projectsQ

  const scheduleQ = supabase
    .from("schedule_items")
    .select(
      "id, project_id, title, description, kind, projects!inner(id, name, project_number)"
    )
    .or(ilikeOr(query, ["title", "description"]))
    .limit(PER_TYPE_LIMIT * 2)
  const scheduleP = projectFilter
    ? scheduleQ.eq("project_id", projectFilter)
    : scheduleQ

  const decisionsQ = supabase
    .from("decisions")
    .select(
      "id, project_id, number, title, description, kind, projects!inner(id, name, project_number)"
    )
    .or(ilikeOr(query, ["title", "description"]))
    .limit(PER_TYPE_LIMIT)
  const decisionsP = projectFilter
    ? decisionsQ.eq("project_id", projectFilter)
    : decisionsQ

  const choicesQ = supabase
    .from("decision_choices")
    .select(
      "id, decision_id, title, description, decisions!inner(id, number, project_id, projects!inner(id, name, project_number))"
    )
    .or(ilikeOr(query, ["title", "description"]))
    .limit(PER_TYPE_LIMIT)
  const choicesP = projectFilter
    ? choicesQ.eq("decisions.project_id", projectFilter)
    : choicesQ

  const dailyLogsQ = supabase
    .from("daily_logs")
    .select(
      "id, project_id, log_date, notes, visibility, projects!inner(id, name, project_number)"
    )
    .ilike("notes", `%${query}%`)
    .limit(PER_TYPE_LIMIT)
  const dailyLogsP = projectFilter
    ? dailyLogsQ.eq("project_id", projectFilter)
    : dailyLogsQ

  const commentsQ = supabase
    .from("decision_comments")
    .select(
      "id, body, decision_id, decisions!inner(id, number, title, project_id, projects!inner(id, name, project_number))"
    )
    .ilike("body", `%${query}%`)
    .limit(PER_TYPE_LIMIT)
  const commentsP = projectFilter
    ? commentsQ.eq("decisions.project_id", projectFilter)
    : commentsQ

  const filesQ = supabase
    .from("project_files")
    .select(
      "id, project_id, title, file_name, description, category, projects!inner(id, name, project_number)"
    )
    .or(ilikeOr(query, ["title", "file_name", "description"]))
    .limit(PER_TYPE_LIMIT)
  const filesP = projectFilter ? filesQ.eq("project_id", projectFilter) : filesQ

  const [
    projectsRes,
    scheduleRes,
    decisionsRes,
    choicesRes,
    dailyLogsRes,
    commentsRes,
    filesRes,
  ] = await Promise.all([
    projectsP,
    scheduleP,
    decisionsP,
    choicesP,
    dailyLogsP,
    commentsP,
    filesP,
  ])

  const out: SearchResult[] = []

  for (const p of projectsRes.data ?? []) {
    out.push({
      type: "project",
      id: p.id,
      project_id: p.id,
      project_name: p.name,
      project_number: p.project_number,
      title: p.name,
      snippet: snippet(p.notes ?? p.address ?? p.client_name, query),
      href: `/projects/${p.id}`,
      meta: p.project_number ? `#${p.project_number}` : null,
    })
  }

  // Generic helper to extract the nested `projects` row PostgREST returns
  // when you join via `projects!inner(...)`. Same key under any depth.
  type WithProject = {
    projects:
      | { id: string; name: string; project_number: string }
      | { id: string; name: string; project_number: string }[]
  }
  const proj = (r: WithProject) =>
    Array.isArray(r.projects) ? r.projects[0] : r.projects

  for (const s of scheduleRes.data ?? []) {
    const p = proj(s as unknown as WithProject)
    out.push({
      type: s.kind === "work" ? "work_item" : "todo",
      id: s.id,
      project_id: s.project_id,
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: s.title,
      snippet: snippet(s.description, query),
      href: `/projects/${s.project_id}/schedule`,
      meta: s.kind === "work" ? "Work item" : "To-do",
    })
  }

  for (const d of decisionsRes.data ?? []) {
    const p = proj(d as unknown as WithProject)
    out.push({
      type: "decision",
      id: d.id,
      project_id: d.project_id,
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: d.title,
      snippet: snippet(d.description, query),
      href: `/projects/${d.project_id}/decisions`,
      meta: `${d.kind === "change_order" ? "Change order" : "Selection"} #${d.number}`,
    })
  }

  type ChoiceRow = {
    id: string
    title: string
    description: string | null
    decisions:
      | {
          id: string
          number: number
          project_id: string
          projects:
            | { id: string; name: string; project_number: string }
            | { id: string; name: string; project_number: string }[]
        }
      | {
          id: string
          number: number
          project_id: string
          projects:
            | { id: string; name: string; project_number: string }
            | { id: string; name: string; project_number: string }[]
        }[]
  }
  for (const c of choicesRes.data ?? []) {
    const cr = c as unknown as ChoiceRow
    const dec = Array.isArray(cr.decisions) ? cr.decisions[0] : cr.decisions
    const p = dec ? (Array.isArray(dec.projects) ? dec.projects[0] : dec.projects) : null
    out.push({
      type: "decision_choice",
      id: cr.id,
      project_id: dec?.project_id ?? "",
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: cr.title,
      snippet: snippet(cr.description, query),
      href: dec ? `/projects/${dec.project_id}/decisions` : "#",
      meta: dec ? `Selection #${dec.number} · choice` : "Choice",
    })
  }

  for (const d of dailyLogsRes.data ?? []) {
    const p = proj(d as unknown as WithProject)
    out.push({
      type: "daily_log",
      id: d.id,
      project_id: d.project_id,
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: `Daily log · ${d.log_date}`,
      snippet: snippet(d.notes, query),
      href: `/projects/${d.project_id}/daily-logs`,
      meta:
        d.visibility === "client" ? "Daily log · client-visible" : "Daily log",
    })
  }

  type CommentRow = {
    id: string
    body: string
    decisions:
      | {
          id: string
          number: number
          title: string
          project_id: string
          projects:
            | { id: string; name: string; project_number: string }
            | { id: string; name: string; project_number: string }[]
        }
      | {
          id: string
          number: number
          title: string
          project_id: string
          projects:
            | { id: string; name: string; project_number: string }
            | { id: string; name: string; project_number: string }[]
        }[]
  }
  for (const c of commentsRes.data ?? []) {
    const cr = c as unknown as CommentRow
    const dec = Array.isArray(cr.decisions) ? cr.decisions[0] : cr.decisions
    const p = dec ? (Array.isArray(dec.projects) ? dec.projects[0] : dec.projects) : null
    out.push({
      type: "decision_comment",
      id: cr.id,
      project_id: dec?.project_id ?? "",
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: dec ? `Comment on “${dec.title}”` : "Comment",
      snippet: snippet(cr.body, query),
      href: dec ? `/projects/${dec.project_id}/decisions` : "#",
      meta: dec ? `Decision #${dec.number} · comment` : "Comment",
    })
  }

  for (const f of filesRes.data ?? []) {
    const p = proj(f as unknown as WithProject)
    out.push({
      type: "project_file",
      id: f.id,
      project_id: f.project_id,
      project_name: p?.name ?? null,
      project_number: p?.project_number ?? null,
      title: f.title || f.file_name,
      snippet: snippet(f.description, query),
      href: `/projects/${f.project_id}/files`,
      meta: `File · ${f.category}`,
    })
  }

  return out
}
