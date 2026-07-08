import Anthropic from "@anthropic-ai/sdk"
import { randomUUID } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { computeScheduleHealth, type MilestoneItem } from "@/lib/schedule/health"
import type { ProposedMutation, AgentTurnResult } from "./types"

// The model. Sonnet 5 is near-Opus quality on exactly this workload —
// tool-use loops and the literal instruction-following the propose_* contract
// depends on (IDs only from tool results, no duplicate proposals) — at
// Sonnet-tier cost. Adaptive thinking is left on (Sonnet 5's default): with
// thinking disabled the model reaches for tools less eagerly, which hurts a
// loop that must call read + propose_* tools to do anything. max_tokens is
// raised to 8192 so a turn's thinking + tool calls + summary never truncate
// (thinking shares the max_tokens budget).
const MODEL = "claude-sonnet-5"
const MAX_TOKENS = 8192

// Hard ceiling on the agent loop. The framing example needs ~3-4 turns
// (list_projects, list_schedule_items per project, then a propose call per
// match) so 30 leaves plenty of headroom without letting a runaway loop run
// the bill up.
const MAX_ITERATIONS = 30

// Server-verified project the model may reference without a list_projects
// call. Resolved from the DB under the caller's session — never taken from
// the client — so the id is safe for the model to use directly. Two modes:
//   - "onsite": the user is physically at the job site (walkthrough) — photos
//     are attached to the daily log automatically.
//   - "page":   the user is viewing this project in the app (global dialog
//     auto-scope) — no photos, just a default project for their request.
export type OnsiteProjectContext = {
  id: string
  name: string
  project_number: string
  address: string | null
  mode?: "onsite" | "page"
  // The staffer running the walkthrough — used as the default assignee for
  // onsite-created to-dos (item 4: every one must have an owner + due date).
  currentUser?: { id: string; name: string } | null
}

const buildSystemPrompt = (
  today: string,
  projectContext?: OnsiteProjectContext | null
) => `You are an AI assistant for Hines Homes' project management system. You help staff make bulk updates across construction projects, and you act as a field-notes assistant when staff relay what's happening on a job site (often dictated from a phone).

Today's date is ${today}.

Your job in a single turn:
1. Use the read tools to understand what the user wants and find the relevant rows.
2. Call the propose_* tools to RECORD intended mutations. These do NOT execute immediately — they're queued for the user to review and approve in a separate step.
3. End with a short text summary describing what you queued and why.

Capability map — what you CAN propose:
- Schedule: create a to-do (optionally assigned to a staff member or a sub/vendor), create a work item, add a checklist item to an existing to-do, update a schedule item's status, update other fields on a schedule item (title/description/dates/parent), and assign an existing schedule item to a staff member or a sub/vendor.
- Decisions: create a draft change order or selection, update its status, add a follow-up to-do template.
- Communication: send an SMS text message to a sub/vendor company that has a phone number on file (find them with list_companies); send a bid reminder to the recipients of a bid package who were invited but haven't responded (find the package with list_bid_packages / get_bid_package).
- Daily logs: append a note to a project's daily log for a given date (creates the log if none exists yet), optionally recording which subs/vendors were on site.

Read-only tools for answering questions (they change nothing): list_projects, list_schedule_items, get_schedule_item, list_decisions, get_decision, list_companies, list_staff, get_schedule_health, list_schedule_delays, list_daily_logs, list_bid_packages, get_bid_package, list_purchase_orders.

What you CANNOT do (don't pretend you can):
- Delete or archive anything.
- Manage predecessors/dependencies, set the schedule baseline, or edit attachments.
- Create or edit bid packages or purchase orders (you can READ them and send bid reminders, but not change their contents).
- Touch files, payments, or edit companies.
- See or report dollar amounts on purchase orders — list_purchase_orders returns status only, never costs.

Reporting mode — when the user asks a QUESTION rather than relaying site notes (e.g. "what's slipping this week?", "which open projects are out of buffer?", "who hasn't bid on the framing package?", "is ABC's workers comp current?", "is the plumber's PO approved?"):
- Use the read-only tools to gather the answer, then reply with a concise plain-text answer. Cite the projects/items by name.
- Do NOT propose any mutations for a pure question, and do NOT append a daily log — a question is not a site note.
- get_schedule_health returns whether a project is in its buffer, days late, and the projected finish; list_schedule_delays explains logged slippage; list_purchase_orders reports PO status (no dollar amounts).

Field notes mode — when the user relays job-site information (a status update from a sub, something that needs doing, an observation):
- Propose the concrete action(s) the note implies. Typical mappings:
  - "The tile guy says he'll finish today" → find the matching schedule work item and propose updating its end_date (and status if clearly implied).
  - "The dumpster needs to be flipped" → find the dumpster/waste company with list_companies and propose_send_sms asking them to swap it.
  - "I need to order more 2x4s" → propose_create_todo ("Order more 2x4s").
  - "Have Jake order the windows" → propose_create_todo with the assignee set (find Jake with list_staff for a staff member, or list_companies for a sub/vendor).
  - "Get the plumber back for the punch item" → find the existing to-do and propose_assign_schedule_item to the plumber's company.
  - "Framers from ABC were on site today" → include ABC in the daily log's subs_on_site (find the company with list_companies).
  - "Remind the electrician about the bid" → find the package with list_bid_packages and propose_send_bid_reminder.
- AND ALWAYS propose exactly one append_daily_log per affected project per turn that records ALL of the user's notes for that project in clean plain language (e.g. "Tile sub reports finishing today. Requested dumpster swap from ABC Disposal. Need to order more 2x4s."), recording any subs/vendors mentioned as on site in subs_on_site. Site notes belong in the daily log even when no other action is needed.
- Identify the project before proposing: if the user named it, or only one project is 'active', use it; otherwise call ask_user to pick.
- Assignments use exactly one assignee — a staff profile OR a sub/vendor company, never both.
${
  projectContext
    ? `
${
  projectContext.mode === "page"
    ? "Current project context — the user is viewing this project in the app:"
    : "On-site context — the user is physically at a job site right now:"
}
- Project: ${projectContext.name} (#${projectContext.project_number}${projectContext.address ? `, ${projectContext.address}` : ""})
- project_id: ${projectContext.id}
- This project_id is server-verified. Exception to the IDs rule below: you may use it directly without calling list_projects first. All OTHER ids (schedule_item_id, decision_id, company_id, …) still must come from tool results.
- Default every proposal and every question to this project. Do not ask which project the user means. Only act on a different project if the user explicitly names one.${
      projectContext.mode === "page"
        ? ""
        : `
- Any photos the user took are uploaded and attached to the daily log automatically outside this conversation — never mention needing them, and don't propose anything about photos.
- Every to-do you propose from these site notes MUST have BOTH a due date AND exactly one assignee. If the note says who should do it, assign them (find staff with list_staff, subs/vendors with list_companies). If no one is named, assign it to the person doing this walkthrough${
          projectContext.currentUser
            ? `: ${projectContext.currentUser.name} (profile id ${projectContext.currentUser.id})`
            : " (the current staff user)"
        }. If the note gives no timeframe, set the due date to today (${today}); otherwise use the near-term date the note implies.`
    }
`
    : ""
}
- SMS rules: keep texts short and professional, identify the project by address or name, and sign off as Hines Homes (e.g. "Hines Homes: Please swap the dumpster at 114 Oak St when you can. Thanks!"). Only propose a text when the user clearly wants a sub/vendor contacted. If the matched company has no phone on file, say so instead of proposing.

Rules:
- **IDs come only from prior tool results.** Never write a project_id, schedule_item_id, decision_id, parent_id, or assignee_*_id that you didn't see returned from a list_* or get_* tool earlier in this same turn. Don't compose IDs from a template (no "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" placeholders); the propose tool will reject the mutation and the user's plan count will silently disagree with your summary. If you need an ID you don't have, call the matching list_* tool first.
- **Dates are ISO YYYY-MM-DD.** If the user gave you "5/30/26" or "May 30", convert it to "2026-05-30" before passing it to a tool. The database stores date columns and rejects ambiguous formats.
- **Match the summary to the plan.** Your final text count must equal the number of propose_* calls that returned queued:true. If any propose call returned an error or queued:false, mention the skip explicitly.
- Never assume — if the request is ambiguous (e.g., "all framing items" → work items, to-dos, or both? "add Final Inspection" → which project? which parent?), call ask_user to clarify and stop.
- When the user says "open projects", that means status IN ('upcoming', 'in_work', 'inventory', 'paused'). 'complete', 'warranty', and 'cancelled' are CLOSED ('warranty' is a post-completion phase).
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
      "List projects in the workspace, optionally filtered by status. Statuses (mirroring the Hines Homes CRM): upcoming, in_work, inventory, paused, complete, warranty, cancelled. 'Open' projects are upcoming + in_work + inventory + paused. 'warranty' is a post-completion phase.",
    input_schema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "upcoming",
              "in_work",
              "inventory",
              "paused",
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
      "Queue creation of a new to-do (kind='todo') in a project. Optionally nests under a work item via parent_id and/or assigns it to one staff member or one sub/vendor. Use this when the user wants to ADD a new actionable task (e.g. 'Add a Final Inspection to-do', 'Have Jake order the windows').",
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
        assignee_profile_id: {
          type: "string",
          description:
            "Staff profile UUID (from list_staff) to assign this to-do to. Mutually exclusive with assignee_company_id.",
        },
        assignee_company_id: {
          type: "string",
          description:
            "Sub/vendor company UUID (from list_companies) to assign this to-do to. Mutually exclusive with assignee_profile_id.",
        },
      },
      required: ["project_id", "title"],
    },
  },
  {
    name: "propose_assign_schedule_item",
    description:
      "Queue assigning an EXISTING schedule item (work item or to-do) to one staff member or one sub/vendor. Use for 'get the plumber back for the punch item' or 'put Jake on framing'. Exactly one of assignee_profile_id / assignee_company_id.",
    input_schema: {
      type: "object",
      properties: {
        schedule_item_id: { type: "string" },
        assignee_profile_id: {
          type: "string",
          description:
            "Staff profile UUID from list_staff (mutually exclusive with assignee_company_id).",
        },
        assignee_company_id: {
          type: "string",
          description:
            "Sub/vendor company UUID from list_companies (mutually exclusive with assignee_profile_id).",
        },
      },
      required: ["schedule_item_id"],
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
      "Queue a daily-log note for a project. On apply, the note is appended to the project's existing daily log for that date, or a new internal log is created if none exists. Use one of these per affected project per turn, combining all of the user's site notes for that project into a single clean note. Record any subs/vendors mentioned as on site in subs_on_site (in addition to the note text) so the who-was-on-site report is complete.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        note: { type: "string", description: "The note text to record." },
        log_date: {
          type: "string",
          description: "YYYY-MM-DD. Omit to use today's date.",
        },
        subs_on_site: {
          type: "array",
          description:
            "Subs/vendors that were on site this day. company_id must come from list_companies.",
          items: {
            type: "object",
            properties: {
              company_id: { type: "string" },
              notes: {
                type: "string",
                description: "Optional note about what this sub did (e.g. 'framing crew of 4').",
              },
            },
            required: ["company_id"],
          },
        },
      },
      required: ["project_id", "note"],
    },
  },
  {
    name: "list_staff",
    description:
      "List internal staff members (id, full_name, email). Use this to resolve a person named in a request ('Jake', 'the PM') to a profile id before assigning a to-do or schedule item to them.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Case-insensitive substring matched against name and email. Omit to return all staff.",
        },
      },
    },
  },
  {
    name: "list_bid_packages",
    description:
      "List bid packages in a project (id, number, title, status, due_date). Statuses: draft, sent, awarded, closed. Use to find a package before checking recipients or sending a reminder.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "sent", "awarded", "closed"],
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_bid_package",
    description:
      "Get a bid package with its recipients — one row per invited company with the company name and their status (invited, submitted, declined, awarded), plus when they last got the invite, viewed it, and submitted. Use this to see who hasn't responded before proposing a reminder.",
    input_schema: {
      type: "object",
      properties: { bid_package_id: { type: "string" } },
      required: ["bid_package_id"],
    },
  },
  {
    name: "propose_send_bid_reminder",
    description:
      "Queue a reminder re-send of a bid package invite to specific recipient companies. Only recipients still in 'invited' status (haven't submitted or declined) with a live invite link are reminded — others are skipped. Nothing is sent until the user approves. Get the package + recipients from get_bid_package first.",
    input_schema: {
      type: "object",
      properties: {
        bid_package_id: { type: "string" },
        company_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Company UUIDs (from get_bid_package recipients) to remind.",
        },
      },
      required: ["bid_package_id", "company_ids"],
    },
  },
  {
    name: "get_schedule_health",
    description:
      "Get a project's schedule health: whether it's inside its 30-day buffer, how many days late, the projected Substantial Completion date, and current vs baseline duration. Returns a state of missing_milestones / missing_dates / no_baseline / tracked. Use to answer 'is this project on track / slipping?'.",
    input_schema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  {
    name: "list_schedule_delays",
    description:
      "List logged schedule delays for a project (which item moved, delay_days, reason_category weather|sub|material|owner_decision|permit|other, notes, when). Use to explain why a project is behind.",
    input_schema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  {
    name: "list_daily_logs",
    description:
      "List a project's daily logs (date, visibility internal|client, notes) most-recent first, optionally within a date range. Use to answer 'what happened on site last week?'.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        from_date: {
          type: "string",
          description: "YYYY-MM-DD lower bound (inclusive). Optional.",
        },
        to_date: {
          type: "string",
          description: "YYYY-MM-DD upper bound (inclusive). Optional.",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "list_purchase_orders",
    description:
      "List purchase orders in a project (number, custom_number, title, status draft|released|approved|declined|void, work_complete flag, and the sub/vendor company name). Dollar amounts are NOT included — never state or estimate PO costs. Use to answer 'do we have a signed PO with this sub?' or 'which POs are still unapproved?'.",
    input_schema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
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

const OPEN_STATUSES = ["upcoming", "in_work", "inventory", "paused"] as const

type ToolInput = Record<string, unknown>

// Resolve an assignee's display name for the plan UI. Returns the name, null
// when no assignee was given, or `false` when the id was given but no row
// matched (so the caller can reject a fabricated id). Exactly one of the two
// ids should be non-null — the caller enforces the XOR.
async function resolveAssigneeName(
  supabase: SupabaseTyped,
  profileId: string | null,
  companyId: string | null
): Promise<string | null | false> {
  if (profileId) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", profileId)
      .maybeSingle()
    if (!prof) return false
    return prof.full_name || prof.email || "Team member"
  }
  if (companyId) {
    const { data: co } = await supabase
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .maybeSingle()
    if (!co) return false
    return co.name
  }
  return null
}

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
      const assigneeName = await resolveAssigneeName(
        supabase,
        assigneeProfileId,
        assigneeCompanyId
      )
      if (assigneeName === false) {
        return JSON.stringify({ error: "assignee not found" })
      }
      state.mutations.push({
        kind: "create_todo",
        project_id: projectId,
        title,
        description: description?.trim() || null,
        due_date: dueDate || null,
        parent_id: parentId,
        assignee_profile_id: assigneeProfileId,
        assignee_company_id: assigneeCompanyId,
        context: {
          project_name: project.name,
          project_number: project.project_number,
          parent_title: parentTitle,
          assignee_name: assigneeName,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "propose_assign_schedule_item": {
      const scheduleItemId = input.schedule_item_id as string
      const assigneeProfileId =
        (input.assignee_profile_id as string | undefined) ?? null
      const assigneeCompanyId =
        (input.assignee_company_id as string | undefined) ?? null
      if (!assigneeProfileId && !assigneeCompanyId) {
        return JSON.stringify({
          error: "provide an assignee_profile_id or assignee_company_id",
        })
      }
      if (assigneeProfileId && assigneeCompanyId) {
        return JSON.stringify({
          error:
            "assignee_profile_id and assignee_company_id are mutually exclusive",
        })
      }
      const { data: item, error } = await supabase
        .from("schedule_items")
        .select("id, title, projects:project_id(name, project_number)")
        .eq("id", scheduleItemId)
        .maybeSingle()
      if (error) return JSON.stringify({ error: error.message })
      if (!item) return JSON.stringify({ error: "schedule item not found" })
      const assigneeName = await resolveAssigneeName(
        supabase,
        assigneeProfileId,
        assigneeCompanyId
      )
      if (assigneeName === false || assigneeName === null) {
        return JSON.stringify({ error: "assignee not found" })
      }
      const project = Array.isArray(item.projects)
        ? item.projects[0]
        : item.projects
      state.mutations.push({
        kind: "assign_schedule_item",
        schedule_item_id: scheduleItemId,
        assignee_profile_id: assigneeProfileId,
        assignee_company_id: assigneeCompanyId,
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          item_title: item.title,
          assignee_name: assigneeName,
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
      // Resolve any subs-on-site company ids to names for the review UI, and
      // reject a fabricated id rather than letting apply fail on it.
      const subsInput =
        (input.subs_on_site as
          | { company_id: string; notes?: string }[]
          | undefined) ?? []
      const subs: {
        company_id: string
        company_name: string
        notes: string | null
      }[] = []
      for (const s of subsInput) {
        if (!s?.company_id) continue
        const { data: co } = await supabase
          .from("companies")
          .select("name")
          .eq("id", s.company_id)
          .maybeSingle()
        if (!co) {
          return JSON.stringify({
            error: `on-site company not found: ${s.company_id}`,
          })
        }
        subs.push({
          company_id: s.company_id,
          company_name: co.name,
          notes: s.notes?.trim() || null,
        })
      }
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
        ...(subs.length > 0 ? { subs_on_site: subs } : {}),
        context: {
          project_name: project.name,
          project_number: project.project_number,
          appends_to_existing: (existing?.length ?? 0) > 0,
        },
      })
      return JSON.stringify({ queued: true })
    }

    case "list_staff": {
      const search = ((input.search as string | undefined) ?? "")
        .trim()
        .toLowerCase()
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .eq("role", "staff")
        .order("full_name")
      if (error) return JSON.stringify({ error: error.message })
      const staff = (data ?? []).filter(
        (p) =>
          !search ||
          (p.full_name ?? "").toLowerCase().includes(search) ||
          (p.email ?? "").toLowerCase().includes(search)
      )
      return JSON.stringify({ staff })
    }

    case "list_bid_packages": {
      const projectId = input.project_id as string
      const status = input.status as
        | "draft"
        | "sent"
        | "awarded"
        | "closed"
        | undefined
      let q = supabase
        .from("bid_packages")
        .select("id, number, title, status, due_date")
        .eq("project_id", projectId)
        .order("number", { ascending: false })
      if (status) q = q.eq("status", status)
      const { data, error } = await q
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ bid_packages: data ?? [] })
    }

    case "get_bid_package": {
      const bidPackageId = input.bid_package_id as string
      const { data: pkg, error: pErr } = await supabase
        .from("bid_packages")
        .select("id, project_id, number, title, status, due_date")
        .eq("id", bidPackageId)
        .maybeSingle()
      if (pErr) return JSON.stringify({ error: pErr.message })
      if (!pkg) return JSON.stringify({ error: "bid package not found" })
      const { data: recipients, error: rErr } = await supabase
        .from("bid_recipients")
        .select(
          "company_id, status, last_sent_at, viewed_at, submitted_at, companies:company_id(name)"
        )
        .eq("bid_package_id", bidPackageId)
      if (rErr) return JSON.stringify({ error: rErr.message })
      const recips = (recipients ?? []).map((r) => {
        const co = Array.isArray(r.companies) ? r.companies[0] : r.companies
        return {
          company_id: r.company_id,
          company_name: co?.name ?? "",
          status: r.status,
          last_sent_at: r.last_sent_at,
          viewed_at: r.viewed_at,
          submitted_at: r.submitted_at,
        }
      })
      return JSON.stringify({ bid_package: pkg, recipients: recips })
    }

    case "propose_send_bid_reminder": {
      const bidPackageId = input.bid_package_id as string
      const companyIds = (input.company_ids as string[] | undefined) ?? []
      if (!companyIds.length)
        return JSON.stringify({ error: "provide at least one company_id" })
      const { data: pkg, error: pErr } = await supabase
        .from("bid_packages")
        .select(
          "id, number, title, status, projects:project_id(name, project_number)"
        )
        .eq("id", bidPackageId)
        .maybeSingle()
      if (pErr) return JSON.stringify({ error: pErr.message })
      if (!pkg) return JSON.stringify({ error: "bid package not found" })
      if (pkg.status === "closed")
        return JSON.stringify({ error: "this bid package is closed" })
      // Only invited-but-unresponded recipients with a live token AND
      // notifications enabled can be reminded — mirror ALL of the apply
      // path's guards here so the plan the user approves lists exactly who
      // will actually be contacted (apply re-checks; this keeps the preview
      // honest).
      const { data: recipients, error: rErr } = await supabase
        .from("bid_recipients")
        .select(
          "company_id, status, token, companies:company_id(name, notifications_enabled)"
        )
        .eq("bid_package_id", bidPackageId)
        .in("company_id", companyIds)
      if (rErr) return JSON.stringify({ error: rErr.message })
      const remindable = (recipients ?? [])
        .filter((r) => {
          const co = Array.isArray(r.companies) ? r.companies[0] : r.companies
          return (
            r.status === "invited" && !!r.token && !!co?.notifications_enabled
          )
        })
        // Match the apply-side plan cap (MAX_BID_REMINDER_RECIPIENTS_PER_PLAN)
        // so a queued plan can always pass validation.
        .slice(0, 25)
      if (!remindable.length) {
        return JSON.stringify({
          queued: false,
          reason:
            "none of those recipients can be reminded (already responded, not invited, link revoked, or notifications disabled for the company)",
        })
      }
      const project = Array.isArray(pkg.projects)
        ? pkg.projects[0]
        : pkg.projects
      const names = remindable.map((r) => {
        const co = Array.isArray(r.companies) ? r.companies[0] : r.companies
        return co?.name ?? ""
      })
      state.mutations.push({
        kind: "send_bid_reminder",
        bid_package_id: bidPackageId,
        company_ids: remindable.map((r) => r.company_id),
        context: {
          project_name: project?.name ?? "",
          project_number: project?.project_number ?? "",
          package_number: pkg.number,
          package_title: pkg.title,
          recipient_names: names,
        },
      })
      return JSON.stringify({ queued: true, reminding: names })
    }

    case "get_schedule_health": {
      const projectId = input.project_id as string
      const { data: project, error: pErr } = await supabase
        .from("projects")
        .select("id, name, baseline_set_at")
        .eq("id", projectId)
        .maybeSingle()
      if (pErr) return JSON.stringify({ error: pErr.message })
      if (!project) return JSON.stringify({ error: "project not found" })
      const { data: items, error } = await supabase
        .from("schedule_items")
        .select(
          "milestone, start_date, end_date, baseline_start_date, baseline_end_date, status"
        )
        .eq("project_id", projectId)
        .not("milestone", "is", null)
      if (error) return JSON.stringify({ error: error.message })
      const health = computeScheduleHealth(
        (items ?? []) as MilestoneItem[],
        project.baseline_set_at,
        today
      )
      return JSON.stringify({ project: project.name, health })
    }

    case "list_schedule_delays": {
      const projectId = input.project_id as string
      const { data, error } = await supabase
        .from("schedule_delays")
        .select(
          "delay_days, reason_category, notes, logged_at, schedule_items!inner(title, project_id)"
        )
        .eq("schedule_items.project_id", projectId)
        .order("logged_at", { ascending: false })
      if (error) return JSON.stringify({ error: error.message })
      const delays = (data ?? []).map((d) => {
        const item = Array.isArray(d.schedule_items)
          ? d.schedule_items[0]
          : d.schedule_items
        return {
          item_title: item?.title ?? "",
          delay_days: d.delay_days,
          reason_category: d.reason_category,
          notes: d.notes,
          logged_at: d.logged_at,
        }
      })
      return JSON.stringify({ delays })
    }

    case "list_daily_logs": {
      const projectId = input.project_id as string
      const fromDate = input.from_date as string | undefined
      const toDate = input.to_date as string | undefined
      let q = supabase
        .from("daily_logs")
        .select("log_date, visibility, notes")
        .eq("project_id", projectId)
        .order("log_date", { ascending: false })
      if (fromDate) q = q.gte("log_date", fromDate)
      if (toDate) q = q.lte("log_date", toDate)
      const { data, error } = await q
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ logs: data ?? [] })
    }

    case "list_purchase_orders": {
      const projectId = input.project_id as string
      // Deliberately no dollar columns (flat_total / line items) — PO costs
      // are gated behind profiles.financial_access at the app layer, not RLS,
      // so the agent must never surface them.
      const { data, error } = await supabase
        .from("purchase_orders")
        .select(
          "number, custom_number, title, status, work_complete, companies:company_id(name)"
        )
        .eq("project_id", projectId)
        .order("number", { ascending: false })
      if (error) return JSON.stringify({ error: error.message })
      const pos = (data ?? []).map((p) => {
        const co = Array.isArray(p.companies) ? p.companies[0] : p.companies
        return {
          number: p.number,
          custom_number: p.custom_number,
          title: p.title,
          status: p.status,
          work_complete: p.work_complete,
          company_name: co?.name ?? "",
        }
      })
      return JSON.stringify({ purchase_orders: pos })
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
  projectContext,
}: {
  messages: Anthropic.Messages.MessageParam[]
  supabase: SupabaseTyped
  apiKey: string
  // The user's LOCAL date (YYYY-MM-DD) — sent by the browser so "today" in
  // a dictated note means the user's today, not the server's UTC day.
  today: string
  // Present for onsite walkthrough turns — scopes proposals to the project
  // the user is standing at. See OnsiteProjectContext.
  projectContext?: OnsiteProjectContext | null
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
  // Set when the turn is cut short so the UI can warn before applying.
  let incomplete: "max_tokens" | "iteration_cap" | undefined

  // Build the system prompt once per turn. It's byte-stable across the loop's
  // iterations (today + projectContext don't change mid-turn), so caching the
  // tools + system prefix is a clean win: render order is tools → system, so
  // one cache_control breakpoint on the system block caches the ~17-tool
  // schema array AND the system prompt together. Every iteration then reads
  // that prefix at ~0.1x input price instead of re-paying it in full.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(today, projectContext),
      cache_control: { type: "ephemeral" },
    },
  ]

  let i = 0
  for (; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Adaptive thinking (Sonnet 5's default) — kept on because a
      // tool-use loop needs the model to keep reaching for tools.
      thinking: { type: "adaptive" },
      system: systemBlocks,
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
      // No tool calls this turn — model is done. If the response itself was
      // truncated (max_tokens), the summary/plan may be missing its tail.
      if (response.stop_reason === "max_tokens") incomplete = "max_tokens"
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
    // A max_tokens stop WITH complete tool_use blocks is not fatal — the
    // model can self-recover on the next iteration, so we don't flag it.
  }

  // Ran the full iteration budget without a natural stop — the plan may be
  // partial. (max_tokens truncation, flagged above, takes precedence.)
  if (i >= MAX_ITERATIONS && !state.question) {
    incomplete = incomplete ?? "iteration_cap"
  }

  if (state.question) {
    return {
      result: { type: "question", question: state.question },
      messages: workingMessages,
    }
  }
  return {
    result: {
      type: "plan",
      // Server-authoritative idempotency key for this plan. See
      // ai_plan_applications — apply refuses to run the same plan twice.
      plan_id: randomUUID(),
      summary,
      mutations: state.mutations,
      ...(incomplete ? { incomplete } : {}),
    },
    messages: workingMessages,
  }
}
