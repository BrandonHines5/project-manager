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

const SYSTEM_PROMPT = `You are an AI assistant for Hines Homes' project management system. You help staff make bulk updates across construction projects.

Your job in a single turn:
1. Use the read tools (list_projects, list_schedule_items, get_schedule_item) to understand what the user wants and find the relevant rows.
2. Call the propose_* tools to RECORD intended mutations. These do NOT execute immediately — they're queued for the user to review and approve in a separate step.
3. End with a short text summary describing what you queued and why.

Rules:
- Never assume — if the request is ambiguous (e.g., "all framing items" — work items, to-dos, or both?), call ask_user to clarify and stop.
- When the user says "open projects", that means status IN ('lead', 'pre_construction', 'active', 'on_hold'). 'complete' and 'cancelled' are CLOSED.
- Match titles case-insensitively. "Framing" should match items titled "Framing", "FRAMING", "Framing - Phase 1", etc.
- Don't propose duplicate work — if a checklist item with the same label already exists on a target, skip it and mention the skip in your summary.
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
      "List projects in the workspace, optionally filtered by status. Statuses: lead, pre_construction, active, on_hold, complete, cancelled. 'Open' projects are lead + pre_construction + active + on_hold.",
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
}: {
  name: string
  input: ToolInput
  supabase: SupabaseTyped
  state: {
    mutations: ProposedMutation[]
    question: string | null
  }
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
}: {
  messages: Anthropic.Messages.MessageParam[]
  supabase: SupabaseTyped
  apiKey: string
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
      system: SYSTEM_PROMPT,
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
