import Anthropic from "@anthropic-ai/sdk"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import type { ProposedMutation, AgentTurnResult } from "./types"

// The model. Sonnet 4.6 is the right balance for tool-use loops here: it's
// fast enough that a 10-tool plan finishes in seconds, and cheap enough that
// each plan run is well under a dollar even with the breadth of read tools.
const MODEL = "claude-sonnet-4-6"

// Hard ceiling on the agent loop. The framing example needs ~3-4 turns
// (list_projects, list_schedule_items per project, then a propose call per
// match) so 30 leaves plenty of headroom without letting a runaway loop run
// the bill up.
const MAX_ITERATIONS = 30

const buildSystemPrompt = (
  today: string
) => `You are an AI assistant for Hines Homes' project management system. You help staff make bulk updates across construction projects, and you act as a field-notes assistant when staff relay what's happening on a job site (often dictated from a phone).

Today's date is ${today}.

Your job in a single turn:
1. Use the read tools to understand what the user wants and find the relevant rows.
2. Call the propose_* tools to RECORD intended mutations. These do NOT execute immediately — they're queued for the user to review and approve in a separate step.
3. End with a short text summary describing what you queued and why.

Capability map — what you CAN propose:
- Schedule: create a to-do, create a work item, add a checklist item to an existing to-do, update a schedule item's status, update other fields on a schedule item (title/description/dates/parent).
- Decisions: create a draft change order or selection, update its status, add a follow-up to-do template.
- Communication: send an SMS text message to a sub/vendor company that has a phone number on file (find them with list_companies).
- Daily logs: append a note to a project's daily log for a given date (creates the log if none exists yet).

What you CANNOT do (don't pretend you can):
- Delete or archive anything.
- Manage assignments, predecessors, or attachments.
- Touch files, payments, or edit companies.

Field notes mode — when the user relays job-site information (a status update from a sub, something that needs doing, an observation):
- Propose the concrete action(s) the note implies. Typical mappings:
  - "The tile guy says he'll finish today" → find the matching schedule work item and propose updating its end_date (and status if clearly implied).
  - "The dumpster needs to be flipped" → find the dumpster/waste company with list_companies and propose_send_sms asking them to swap it.
  - "I need to order more 2x4s" → propose_create_todo ("Order more 2x4s").
- AND ALWAYS propose exactly one append_daily_log per affected project per turn that records ALL of the user's notes for that project in clean plain language (e.g. "Tile sub reports finishing today. Requested dumpster swap from ABC Disposal. Need to order more 2x4s."). Site notes belong in the daily log even when no other action is needed.
- Identify the project before proposing: if the user named it, or only one project is 'active', use it; otherwise call ask_user to pick.
- SMS rules: keep texts short and professional, identify the project by address or name, and sign off as Hines Homes (e.g. "Hines Homes: Please swap the dumpster at 114 Oak St when you can. Thanks!"). Only propose a text when the user clearly wants a sub/vendor contacted. If the matched company has no phone on file, say so instead of proposing.

Rules:
- **IDs come only from prior tool results.** Never write a project_id, schedule_item_id, decision_id, parent_id, or assignee_*_id that you didn't see returned from a list_* or get_* tool earlier in this same turn. Don't compose IDs from a template (no "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" placeholders); the propose tool will reject the mutation and the user's plan count will silently disagree with your summary. If you need an ID you don't have, call the matching list_* tool first.
- **Dates are ISO YYYY-MM-DD.** If the user gave you "5/30/26" or "May 30", convert it to "2026-05-30" before passing it to a tool. The database stores date columns and rejects ambiguous formats.
- **Match the summary to the plan.** Your final text count must equal the number of propose_* calls that returned queued:true. If any propose call returned an error or queued:false, mention the skip explicitly.
- Never assume — if the request is ambiguous (e.g., "all framing items" → work items, to-dos, or both? "add Final Inspection" → which project? which parent?), call ask_user to clarify and stop.
- When the user says "open projects", that means status IN ('lead', 'pre_construction', 'active', 'on_hold'). 'complete', 'warranty', and 'cancelled' are CLOSED ('warranty' is a post-completion phase).
- Match titles case-insensitively. "Framing" should match items titled "Framing", "FRAMING", "Framing - Phase 1", etc.
- Don't propose duplicate work — if a checklist item with the same label already exists on a target, skip it and mention the skip in your summary.
- For create_work_item, both start_date and end_date are required and end must be on or after start. Use YYYY-MM-DD.
- For update_schedule_item, only include the fields that are changing in the patch.
- New decisions start as draft. To send to the client, propose a separate update_decision_status to 'pending_client' after creating.
- Keep your final text summary short (2-3 sentences). The plan UI shows each mutation row separately.
- Only use tools that exist. Do not invent capabilities.
`

// Build the tool definitions in raw JSON-schema form. We use the manual
// agentic loop instead of the SDK's tool runner so we can (a) collect
// propose_* calls into the mutations array as side effects, (b) break the
// loop cleanly when ask_user is invoked, and (c) cap the iteration count.
type SupabaseTyped = SupabaseClient<Database>

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_projects",
    description:
      "List projects in the workspace, optionally filtered by status. Statuses: lead, pre_construction, active, on_hold, complete, warranty, cancelled. 'Open' projects are lead + pre_construction + active + on_hold. 'warranty' is a post-completion phase.",
    input_schema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "lead",
              "pre_construction",
              "active",
              "on_hold",
              "complete",
              "warranty",
              "cancelled",
            ],
          },
          description: "Filter to these statuses. Omit to return all.",
        },
      },
    },
  },
  {
    name: "list_schedule_items",
    description:
      "List schedule items in a project, optionally filtered by kind ('work' | 'todo') and a substring of the title (case-insensitive).",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        kind: { type: "string", enum: ["work", "todo"] },
        title_contains: {
          type: "string",
          description:
            "Case-insensitive substring match on the item title. Omit to return all items.",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_schedule_item",
    description:
      "Get a single schedule item with its full checklist (for to-dos) so you can see if a checklist item already exists before proposing a duplicate add.",
    input_schema: {
      type: "object",
      properties: {
        schedule_item_id: { type: "string" },
      },
      required: ["schedule_item_id"],
    },
  },
  {
    name: "propose_add_checklist_item",
    description:
      "Queue an 'add checklist item' mutation for the user to review. Targets a single schedule item (must be kind='todo' to have a checklist). Returns immediately — nothing is persisted until the user approves the plan.",
    input_schema: {
      type: "object",
      properties: {
        schedule_item_id: { type: "string" },
        label: { type: "string", description: "The new checklist item label." },
      },
      required: ["schedule_item_id", "label"],
    },
  },
  {
    name: "propose_update_schedule_item_status",
    description:
      "Queue a 'change status' mutation. Statuses: not_started, in_progress, complete, delayed.",
    input_schema: {
      type: "object",
      properties: {
        schedule_item_id: { type: "string" },
        status: {
          type: "string",
          enum: ["not_started", "in_progress", "complete", "delayed"],
        },
      },
      required: ["schedule_item_id", "status"],
    },
  },
  {
    name: "propose_update_schedule_item",
    description:
      "Queue an 'update schedule item' mutation. Only include the fields that should change. For work items, start_date + end_date must both be set if either is changed, and end_date >= start_date. For to-dos, due_date is the relevant date field. parent_id can be set to a work item's ID to nest a to-do under it, or null to detach.",
    input_schema: {
      type: "object",
      properties: {
        schedule_item_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD or null to clear" },
        end_date: { type: "string", description: "YYYY-MM-DD or null to clear" },
        due_date: { type: "string", description: "YYYY-MM-DD or null to clear" },
        parent_id: {
          type: "string",
          description: "Work item id to set as parent, or null to detach",
        },
      },
      required: ["schedule_item_id"],
    },
  },
  {
    name: "propose_create_todo",
    description:
      "Queue creation of a new to-do (kind='todo') in a project. Optionally nests under a work item via parent_id. Use this when the user wants to ADD a new actionable task (e.g. 'Add a Final Inspection to-do').",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string", description: "YYYY-MM-DD, optional" },
        parent_id: {
          type: "string",
          description: "A work item id to nest this to-do under. Optional.",
        },
      },
      required: ["project_id", "title"],
    },
  },
  {
    name: "propose_create_work_item",
    description:
      "Queue creation of a new work item (kind='work') in a project. Work items have a start_date and end_date (both required, end >= start, YYYY-MM-DD).",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["project_id", "title", "start_date", "end_date"],
    },
  },
  {
    name: "list_decisions",
    description:
      "List decisions in a project, optionally filtered by kind (change_order | selection) and status. Statuses: draft, pending_client, approved, rejected.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        kind: { type: "string", enum: ["change_order", "selection"] },
        status: {
          type: "string",
          enum: ["draft", "pending_client", "approved", "rejected"],
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_decision",
    description:
      "Get a single decision with its existing follow-up templates so you can avoid proposing duplicate follow-ups.",
    input_schema: {
      type: "object",
      properties: { decision_id: { type: "string" } },
      required: ["decision_id"],
    },
  },
  {
    name: "propose_create_decision",
    description:
      "Queue creation of a new decision (change_order or selection) in a project. The decision starts in 'draft' status. To send it to the client, propose a separate update_decision_status with status='pending_client'.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        decision_kind: {
          type: "string",
          enum: ["change_order", "selection"],
        },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["project_id", "decision_kind", "title"],
    },
  },
  {
    name: "propose_update_decision_status",
    description:
      "Queue a status change on an existing decision. Valid transitions: draft → pending_client; pending_client → approved | rejected. Don't propose moves backwards (e.g. approved → draft).",
    input_schema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "pending_client", "approved", "rejected"],
        },
      },
      required: ["decision_id", "status"],
    },
  },
  {
    name: "propose_add_decision_followup",
    description:
      "Queue addition of a follow-up to-do template to a decision. These materialize as schedule_items (kind='todo') when the decision becomes 'approved'. due_offset_days is the integer number of days after approval the to-do should be due.",
    input_schema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        title: { type: "string" },
        due_offset_days: { type: "integer", minimum: 0 },
        assignee_profile_id: {
          type: "string",
          description:
            "Staff profile UUID to assign the to-do to (mutually exclusive with assignee_company_id).",
        },
        assignee_company_id: {
          type: "string",
          description:
            "Sub/vendor company UUID to assign the to-do to (mutually exclusive with assignee_profile_id).",
        },
      },
      required: ["decision_id", "title", "due_offset_days"],
    },
  },
  {
    name: "list_companies",
    description:
      "List sub/vendor companies in the directory with their trades and whether a phone number is on file. Optionally filter by a case-insensitive search term matched against the company name, trade category, and trade tags (e.g. 'dumpster', 'tile', 'ABC Disposal'). Use this to find the right company before proposing an SMS.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Case-insensitive substring matched against name, trade category, and trades. Omit to return all companies.",
        },
      },
    },
  },
  {
    name: "propose_send_sms",
    description:
      "Queue an SMS text message to a sub/vendor company for the user to review. The company must have a phone number on file (check via list_companies). Keep the message short, identify the project by address or name, and sign off as Hines Homes. Nothing is sent until the user approves the plan.",
    input_schema: {
      type: "object",
      properties: {
        company_id: { type: "string" },
        message: {
          type: "string",
          description: "The SMS body to send (max 1600 characters).",
        },
        project_id: {
          type: "string",
          description:
            "Optional project this text relates to — used for display context in the review UI.",
        },
      },
      required: ["company_id", "message"],
    },
  },
  {
    name: "propose_append_daily_log",
    description:
      "Queue a daily-log note for a project. On apply, the note is appended to the project's existing daily log for that date, or a new internal log is created if none exists. Use one of these per affected project per turn, combining all of the user's site notes for that project into a single clean note.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        note: { type: "string", description: "The note text to record." },
        log_date: {
          type: "string",
          description: "YYYY-MM-DD. Omit to use today's date.",
        },
      },
      required: ["project_id", "note"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when the request is ambiguous. After calling this, STOP — produce no further tool calls and no final text. The session will pause and the user's reply will arrive on the next turn.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
]

const OPEN_STATUSES = ["lead", "pre_construction", "active", "on_hold"] as const

type ToolInput = Record<string, unknown>

// Execute a tool call against Supabase (read tools) or append to the in-flight
// plan (propose_* tools). Returns a JSON string that gets fed back to the
// model as the tool_result content.
async function executeTool({
  name,
  input,
  supabase,
  state,
  today,
}: {
  name: string
  input: ToolInput
  supabase: SupabaseTyped
  state: {
    mutations: ProposedMutation[]
    question: string | null
  }
  today: string
}): Promise<string> {
  switch (name) {
    case "list_projects": {
      const statuses = (input.statuses as string[] | undefined) ?? null
      let q = supabase
        .from("projects")
        .select("id, name, project_number, status")
        .order("project_number")
      if (statuses?.length) {
        q = q.in(
          "status",
          statuses as Database["public"]["Enums"]["project_status"][]
        )
      }
      const { data, error } = await q
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ projects: data ?? [] })
    }

    case "list_schedule_items": {
      const projectId = input.project_id as string
      const kind = input.kind as "work" | "todo" | undefined
      const titleContains = input.title_contains as string | undefined
      let q = supabase
        .from("schedule_items")
        .select("id, project_id, title, kind, status, parent_id, due_date")
        .eq("project_id", projectId)
        .order("position")
      if (kind) q = q.eq("kind", kind)
      if (titleContains) q = q.ilike("title", `%${titleContains}%`)
      const { data, error } = await q
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ items: data ?? [] })
    }

    case "get_schedule_item": {
      const scheduleItemId = input.schedule_item_id as string
      const { data: item, error: itemErr } = await supabase
        .from("schedule_items")
        .select(
          "id, project_id, title, kind, status, parent_id, due_date, description"
        )
        .eq("id", scheduleItemId)
        .maybeSingle()
      if (itemErr) return JSON.stringify({ error: itemErr.message })
      if (!item) return JSON.stringify({ error: "not found" })
      const { data: checklist } = await supabase
        .from("todo_checklist_items")
        .select("id, label, is_done, position")
        .eq("schedule_item_id", scheduleItemId)
        .order("position")
      return JSON.stringify({ item, checklist: checklist ?? [] })
    }

    case "propose_add_checklist_item": {
      const scheduleItemId = input.schedule_item_id as string
      const label = (input.label as string).trim()
      if (!label) return JSON.stringify({ error: "label cannot be empty" })
      // Fetch context to attach to the mutation. RLS gates this.
      const { data: item, error } = await supabase
        .from("schedule_items")
        .select(
          "id, title, kind, projects:project_id(name, project_number)"
        )
        .eq("id", scheduleItemId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!item) return JSON.stringify({ error: "schedule item not found" })
      if (item.kind !== "todo") {
        return JSON.stringify({
          error:
            "Cannot add a checklist item to a work item — checklists exist only on to-dos.",
        })
      }
      const project = Array.isArray(item.projects)
        ? item.projects[0]
        : item.projects
      state.mutations.push({
        kind: "add_checklist_item",
        schedule_item_id: scheduleItemId,
        label,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          item_title: item.title,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_update_schedule_item_status": {
      const scheduleItemId = input.schedule_item_id as string
      const status = input.status as
        | "not_started"
        | "in_progress"
        | "complete"
        | "delayed"
      const { data: item, error } = await supabase
        .from("schedule_items")
        .select(
          "id, title, status, projects:project_id(name, project_number)"
        )
        .eq("id", scheduleItemId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!item) return JSON.stringify({ error: "schedule item not found" })
      if (item.status === status) {
        return JSON.stringify({
          queued: false,
          reason: `status is already ${status}; skipping`,
        })
      }
      const project = Array.isArray(item.projects)
        ? item.projects[0]
        : item.projects
      state.mutations.push({
        kind: "update_schedule_item_status",
        schedule_item_id: scheduleItemId,
        status,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          item_title: item.title,
          previous_status: item.status,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_update_schedule_item": {
      const scheduleItemId = input.schedule_item_id as string
      const patch: Record<string, string | null> = {}
      const changes: string[] = []
      const { data: item, error } = await supabase
        .from("schedule_items")
        .select(
          "id, title, description, kind, start_date, end_date, due_date, parent_id, projects:project_id(name, project_number)"
        )
        .eq("id", scheduleItemId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!item) return JSON.stringify({ error: "schedule item not found" })

      // Build the patch field-by-field and produce a human-readable diff
      // for the plan UI. Only include keys the agent actually passed.
      for (const f of [
        "title",
        "description",
        "start_date",
        "end_date",
        "due_date",
        "parent_id",
      ] as const) {
        if (f in input) {
          const next = input[f] as string | null
          const prev = (item as unknown as Record<string, unknown>)[f] as
            | string
            | null
          if (next !== prev) {
            patch[f] = next
            changes.push(`${f}: ${prev ?? "—"} → ${next ?? "—"}`)
          }
        }
      }
      if (Object.keys(patch).length === 0) {
        return JSON.stringify({
          queued: false,
          reason: "no fields changed; skipping",
        })
      }
      // Refuse obviously-bad patches up front rather than failing at apply
      // time — keeps the agent's plan honest.
      if (item.kind === "work") {
        const finalStart = (patch.start_date ?? item.start_date) as
          | string
          | null
        const finalEnd = (patch.end_date ?? item.end_date) as string | null
        if (finalStart && finalEnd && finalEnd < finalStart) {
          return JSON.stringify({
            error: "end_date must be on or after start_date",
          })
        }
      }
      const project = Array.isArray(item.projects)
        ? item.projects[0]
        : item.projects
      state.mutations.push({
        kind: "update_schedule_item",
        schedule_item_id: scheduleItemId,
        patch,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          item_title: item.title,
          changes,
        },
      })
      return JSON.stringify({ queued: true, changes })
    }

    case "propose_create_todo": {
      const projectId = input.project_id as string
      const title = (input.title as string).trim()
      const description = (input.description as string | undefined) ?? null
      const dueDate = (input.due_date as string | undefined) ?? null
      const parentId = (input.parent_id as string | undefined) ?? null
      if (!title) return JSON.stringify({ error: "title required" })
      const { data: project, error: pErr } = await supabase
        .from("projects")
        .select("id, name, project_number")
        .eq("id", projectId)
        .maybeSingle()
      if (pErr) return JSON.stringify({ error: pErr.message })
      if (!project) return JSON.stringify({ error: "project not found" })
      let parentTitle: string | null = null
      if (parentId) {
        const { data: parent } = await supabase
          .from("schedule_items")
          .select("title, kind, project_id")
          .eq("id", parentId)
          .maybeSingle()
        if (!parent)
          return JSON.stringify({ error: "parent item not found" })
        if (parent.project_id !== projectId)
          return JSON.stringify({
            error: "parent belongs to a different project",
          })
        if (parent.kind !== "work")
          return JSON.stringify({
            error: "parent must be a work item",
          })
        parentTitle = parent.title
      }
      state.mutations.push({
        kind: "create_todo",
        project_id: projectId,
        title,
        description: description?.trim() || null,
        due_date: dueDate || null,
        parent_id: parentId,
        context: {
          project_name: project.name,
          project_number: project.project_number,
          parent_title: parentTitle,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_create_work_item": {
      const projectId = input.project_id as string
      const title = (input.title as string).trim()
      const description = (input.description as string | undefined) ?? null
      const startDate = input.start_date as string
      const endDate = input.end_date as string
      if (!title) return JSON.stringify({ error: "title required" })
      if (!startDate || !endDate)
        return JSON.stringify({
          error: "start_date and end_date are both required",
        })
      if (endDate < startDate)
        return JSON.stringify({
          error: "end_date must be on or after start_date",
        })
      const { data: project, error } = await supabase
        .from("projects")
        .select("id, name, project_number")
        .eq("id", projectId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!project) return JSON.stringify({ error: "project not found" })
      state.mutations.push({
        kind: "create_work_item",
        project_id: projectId,
        title,
        description: description?.trim() || null,
        start_date: startDate,
        end_date: endDate,
        context: {
          project_name: project.name,
          project_number: project.project_number,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "list_decisions": {
      const projectId = input.project_id as string
      const kind = input.kind as "change_order" | "selection" | undefined
      const status = input.status as
        | "draft"
        | "pending_client"
        | "approved"
        | "rejected"
        | undefined
      let q = supabase
        .from("decisions")
        .select("id, project_id, number, kind, title, status, due_date")
        .eq("project_id", projectId)
        .order("number", { ascending: false })
      if (kind) q = q.eq("kind", kind)
      if (status) q = q.eq("status", status)
      const { data, error } = await q
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ decisions: data ?? [] })
    }

    case "get_decision": {
      const decisionId = input.decision_id as string
      const { data: decision, error: dErr } = await supabase
        .from("decisions")
        .select(
          "id, project_id, number, kind, title, description, status, due_date"
        )
        .eq("id", decisionId)
        .maybeSingle()
      if (dErr) return JSON.stringify({ error: dErr.message })
      if (!decision) return JSON.stringify({ error: "decision not found" })
      const { data: followups } = await supabase
        .from("decision_followup_templates")
        .select(
          "id, title, due_offset_days, assignee_profile_id, assignee_company_id"
        )
        .eq("decision_id", decisionId)
        .order("position")
      return JSON.stringify({ decision, followups: followups ?? [] })
    }

    case "propose_create_decision": {
      const projectId = input.project_id as string
      const decisionKind = input.decision_kind as "change_order" | "selection"
      const title = (input.title as string).trim()
      const description = (input.description as string | undefined) ?? null
      if (!title) return JSON.stringify({ error: "title required" })
      const { data: project, error } = await supabase
        .from("projects")
        .select("id, name, project_number")
        .eq("id", projectId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!project) return JSON.stringify({ error: "project not found" })
      state.mutations.push({
        kind: "create_decision",
        project_id: projectId,
        decision_kind: decisionKind,
        title,
        description: description?.trim() || null,
        context: {
          project_name: project.name,
          project_number: project.project_number,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_update_decision_status": {
      const decisionId = input.decision_id as string
      const status = input.status as
        | "draft"
        | "pending_client"
        | "approved"
        | "rejected"
      const { data: decision, error } = await supabase
        .from("decisions")
        .select(
          "id, number, title, status, projects:project_id(name, project_number)"
        )
        .eq("id", decisionId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!decision) return JSON.stringify({ error: "decision not found" })
      if (decision.status === status) {
        return JSON.stringify({
          queued: false,
          reason: `status is already ${status}; skipping`,
        })
      }
      const project = Array.isArray(decision.projects)
        ? decision.projects[0]
        : decision.projects
      state.mutations.push({
        kind: "update_decision_status",
        decision_id: decisionId,
        status,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          decision_number: decision.number,
          decision_title: decision.title,
          previous_status: decision.status,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_add_decision_followup": {
      const decisionId = input.decision_id as string
      const title = (input.title as string).trim()
      const dueOffsetDays = input.due_offset_days as number
      const assigneeProfileId =
        (input.assignee_profile_id as string | undefined) ?? null
      const assigneeCompanyId =
        (input.assignee_company_id as string | undefined) ?? null
      if (!title) return JSON.stringify({ error: "title required" })
      if (assigneeProfileId && assigneeCompanyId) {
        return JSON.stringify({
          error:
            "assignee_profile_id and assignee_company_id are mutually exclusive",
        })
      }
      const { data: decision, error } = await supabase
        .from("decisions")
        .select(
          "id, number, title, projects:project_id(name, project_number)"
        )
        .eq("id", decisionId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!decision) return JSON.stringify({ error: "decision not found" })
      let assigneeName: string | null = null
      if (assigneeProfileId) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("full_name, email")
          .eq("id", assigneeProfileId)
          .maybeSingle()
        assigneeName = prof?.full_name || prof?.email || null
      } else if (assigneeCompanyId) {
        const { data: co } = await supabase
          .from("companies")
          .select("name")
          .eq("id", assigneeCompanyId)
          .maybeSingle()
        assigneeName = co?.name ?? null
      }
      const project = Array.isArray(decision.projects)
        ? decision.projects[0]
        : decision.projects
      state.mutations.push({
        kind: "add_decision_followup",
        decision_id: decisionId,
        title,
        due_offset_days: Math.trunc(dueOffsetDays),
        assignee_profile_id: assigneeProfileId,
        assignee_company_id: assigneeCompanyId,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          decision_number: decision.number,
          decision_title: decision.title,
          assignee_name: assigneeName,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "list_companies": {
      const search = ((input.search as string | undefined) ?? "")
        .trim()
        .toLowerCase()
      // The directory is small (dozens, not thousands) so we pull it whole
      // and filter in JS — lets one search term match across name, trade
      // category, AND the trade tags without a messy or() filter.
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, type, trade_category, phone, company_trades(trade)")
        .order("name")
      if (error) return JSON.stringify({ error: error.message })
      const companies = (data ?? [])
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          trade_category: c.trade_category,
          trades: (c.company_trades ?? []).map((t) => t.trade),
          has_phone: !!c.phone,
        }))
        .filter(
          (c) =>
            !search ||
            c.name.toLowerCase().includes(search) ||
            (c.trade_category ?? "").toLowerCase().includes(search) ||
            c.trades.some((t) => t.toLowerCase().includes(search))
        )
      return JSON.stringify({ companies })
    }

    case "propose_send_sms": {
      const companyId = input.company_id as string
      const message = (input.message as string).trim()
      const projectId = (input.project_id as string | undefined) ?? null
      if (!message) return JSON.stringify({ error: "message cannot be empty" })
      if (message.length > 1600)
        return JSON.stringify({
          error: "message exceeds the 1600-character SMS limit",
        })
      const { data: company, error } = await supabase
        .from("companies")
        .select("id, name, phone")
        .eq("id", companyId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!company) return JSON.stringify({ error: "company not found" })
      if (!company.phone)
        return JSON.stringify({
          error: `${company.name} has no phone number on file — tell the user instead of texting.`,
        })
      let projectName: string | null = null
      let projectNumber: string | null = null
      if (projectId) {
        const { data: project } = await supabase
          .from("projects")
          .select("name, project_number")
          .eq("id", projectId)
          .maybeSingle()
        projectName = project?.name ?? null
        projectNumber = project?.project_number ?? null
      }
      state.mutations.push({
        kind: "send_sms",
        company_id: companyId,
        message,
        context: {
          company_name: company.name,
          company_phone: company.phone,
          project_name: projectName,
          project_number: projectNumber,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_append_daily_log": {
      const projectId = input.project_id as string
      const note = (input.note as string).trim()
      const logDate = ((input.log_date as string | undefined) ?? today).trim()
      if (!note) return JSON.stringify({ error: "note cannot be empty" })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate))
        return JSON.stringify({ error: "log_date must be YYYY-MM-DD" })
      const { data: project, error } = await supabase
        .from("projects")
        .select("id, name, project_number")
        .eq("id", projectId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!project) return JSON.stringify({ error: "project not found" })
      const { data: existing } = await supabase
        .from("daily_logs")
        .select("id")
        .eq("project_id", projectId)
        .eq("log_date", logDate)
        .limit(1)
      state.mutations.push({
        kind: "append_daily_log",
        project_id: projectId,
        log_date: logDate,
        note,
        context: {
          project_name: project.name,
          project_number: project.project_number,
          appends_to_existing: (existing?.length ?? 0) > 0,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "ask_user": {
      state.question = input.question as string
      return JSON.stringify({
        accepted: true,
        instruction:
          "The user will receive this question. Stop now — do not call further tools or produce final text.",
      })
    }

    default:
      return JSON.stringify({ error: `unknown tool: ${name}` })
  }
}

// The "open projects" hint is generically useful so we put it in a fenced
// note in the system prompt rather than as a literal mapping inside a tool.
void OPEN_STATUSES

/**
 * Run one turn of the agent loop with the given conversation history.
 *
 * Why this is a manual tool-use loop instead of the SDK's tool runner:
 * - We need to interrupt the loop when `ask_user` fires, but only AFTER
 *   the tool result for that call is sent back so Claude can wrap up
 *   cleanly. The tool runner doesn't expose a "stop here" hook.
 * - We collect propose_* calls into a side-effect array, which is easier
 *   to manage explicitly than via a closure inside the runner.
 * - We cap iteration to avoid a runaway agent burning tokens — the runner
 *   has its own internal cap but it's not the one we want.
 */
export async function runAgentTurn({
  messages,
  supabase,
  apiKey,
  today,
}: {
  messages: Anthropic.Messages.MessageParam[]
  supabase: SupabaseTyped
  apiKey: string
  // The user's LOCAL date (YYYY-MM-DD) — sent by the browser so "today" in
  // a dictated note means the user's today, not the server's UTC day.
  today: string
}): Promise<{
  result: AgentTurnResult
  // The updated conversation, including everything Claude produced this turn
  // (assistant turns and tool_result user turns). Caller stores this and
  // sends it back on the next turn.
  messages: Anthropic.Messages.MessageParam[]
}> {
  const client = new Anthropic({ apiKey })

  const state: {
    mutations: ProposedMutation[]
    question: string | null
  } = { mutations: [], question: null }

  const workingMessages: Anthropic.Messages.MessageParam[] = [...messages]
  let summary = ""

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(today),
      tools: TOOLS,
      messages: workingMessages,
    })

    workingMessages.push({ role: "assistant", content: response.content })

    // Pull every text block out as the running summary. The last assistant
    // turn's text is what we surface to the user.
    summary = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim()

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    )

    if (toolUseBlocks.length === 0) {
      // No tool calls this turn — model is done. Return whatever we have.
      break
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tool of toolUseBlocks) {
      const content = await executeTool({
        name: tool.name,
        input: tool.input as ToolInput,
        supabase,
        state,
        today,
      })
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content,
      })
    }
    workingMessages.push({ role: "user", content: toolResults })

    // ask_user terminates the turn — we've already shipped the tool result
    // back so the assistant doesn't see "the conversation just ended"
    // unexpectedly, but we don't run another inference round.
    if (state.question) break

    if (response.stop_reason === "end_turn") break
  }

  if (state.question) {
    return {
      result: { type: "question", question: state.question },
      messages: workingMessages,
    }
  }
  return {
    result: { type: "plan", summary, mutations: state.mutations },
    messages: workingMessages,
  }
}
