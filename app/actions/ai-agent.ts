"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { runAgentTurn } from "@/lib/ai/agent"
import { applyPlan as applyPlanInternal } from "@/lib/ai/apply"
import type { AgentTurnResult, AppliedMutation, ProposedMutation } from "@/lib/ai/types"
import type Anthropic from "@anthropic-ai/sdk"

// The conversation is stored client-side and shipped in full on every turn.
// We only allow user + assistant messages (no tool_use / tool_result blocks
// in the inbound payload — those are generated server-side and don't need
// to round-trip through the client). This keeps the wire surface small AND
// prevents a tampered client from injecting fake tool results.
const ClientMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
})
const TurnInputSchema = z.object({
  messages: z.array(ClientMessageSchema).min(1).max(40),
  // The browser's local calendar date. Site notes are dictated from phones,
  // so "today" must mean the user's day, not the server's UTC day (which
  // rolls over at ~6pm in the US). Falls back to server date if absent.
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
type ClientMessage = z.infer<typeof ClientMessageSchema>

// On the server we expand the simple {role, content: string} messages into
// the full Anthropic message shape. Server-side server-turn additions (tool
// results, prior assistant turns with tool_use blocks) are recreated by
// running the loop fresh each time — there's no statefulness across turns
// other than the simple text conversation. That matches how a user thinks
// about the agent ("here's what I said, here's what it said back") and
// avoids leaking server internals to the client.
function toClaudeMessages(
  msgs: ClientMessage[]
): Anthropic.Messages.MessageParam[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }))
}

export async function runAgentTurnAction(input: {
  messages: ClientMessage[]
  today?: string
}): Promise<AgentTurnResult> {
  await requireStaff()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      type: "error",
      message:
        "ANTHROPIC_API_KEY is not configured on the server. Add it in Vercel project settings (or .env.local for dev) and redeploy.",
    }
  }
  const parsed = TurnInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      type: "error",
      message: `Invalid input: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    }
  }
  const supabase = await createSupabaseServerClient()
  try {
    const { result } = await runAgentTurn({
      messages: toClaudeMessages(parsed.data.messages),
      supabase,
      apiKey,
      today: parsed.data.today ?? new Date().toISOString().slice(0, 10),
    })
    return result
  } catch (e) {
    return {
      type: "error",
      message: e instanceof Error ? e.message : "Agent failed",
    }
  }
}

// The plan is also shipped client-side and back. We re-validate every
// mutation entering this action — never trust the client to have left them
// untampered. RLS is the ultimate gate (a user can't execute a mutation
// they couldn't perform manually) but client-side validation surfaces a
// nicer error than a generic 401.
const MutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add_checklist_item"),
    schedule_item_id: z.string().uuid(),
    label: z.string().min(1).max(500),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      item_title: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("update_schedule_item_status"),
    schedule_item_id: z.string().uuid(),
    status: z.enum(["not_started", "in_progress", "complete", "delayed"]),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      item_title: z.string(),
      previous_status: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("update_schedule_item"),
    schedule_item_id: z.string().uuid(),
    patch: z
      .object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(5000).nullable().optional(),
        start_date: z.string().nullable().optional(),
        end_date: z.string().nullable().optional(),
        due_date: z.string().nullable().optional(),
        parent_id: z.string().uuid().nullable().optional(),
      })
      // At least one key — guards against an empty patch sneaking through.
      .refine((p) => Object.keys(p).length > 0, {
        message: "patch must include at least one field",
      }),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      item_title: z.string(),
      changes: z.array(z.string()),
    }),
  }),
  z.object({
    kind: z.literal("create_todo"),
    project_id: z.string().uuid(),
    title: z.string().min(1).max(300),
    description: z.string().max(5000).nullable(),
    due_date: z.string().nullable(),
    parent_id: z.string().uuid().nullable(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      parent_title: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal("create_work_item"),
    project_id: z.string().uuid(),
    title: z.string().min(1).max(300),
    description: z.string().max(5000).nullable(),
    start_date: z.string(),
    end_date: z.string(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("create_decision"),
    project_id: z.string().uuid(),
    decision_kind: z.enum(["change_order", "selection"]),
    title: z.string().min(1).max(300),
    description: z.string().max(5000).nullable(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("update_decision_status"),
    decision_id: z.string().uuid(),
    status: z.enum(["draft", "pending_client", "approved", "rejected"]),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      decision_number: z.number(),
      decision_title: z.string(),
      previous_status: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("add_decision_followup"),
    decision_id: z.string().uuid(),
    title: z.string().min(1).max(300),
    due_offset_days: z.number().int().min(0).max(365),
    assignee_profile_id: z.string().uuid().nullable(),
    assignee_company_id: z.string().uuid().nullable(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      decision_number: z.number(),
      decision_title: z.string(),
      assignee_name: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal("append_daily_log"),
    project_id: z.string().uuid(),
    log_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().min(1).max(5000),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      appends_to_existing: z.boolean(),
    }),
  }),
  z.object({
    kind: z.literal("send_sms"),
    company_id: z.string().uuid(),
    message: z.string().min(1).max(1600),
    context: z.object({
      company_name: z.string(),
      company_phone: z.string(),
      project_name: z.string().nullable(),
      project_number: z.string().nullable(),
    }),
  }),
])
// A plan is capped at 200 mutations overall, but SMS leaves the building —
// a tampered payload with 200 send_sms entries would be a texting cannon.
// Field notes realistically text at most a handful of subs per apply.
const MAX_SMS_PER_PLAN = 5
const ApplyInputSchema = z.object({
  mutations: z
    .array(MutationSchema)
    .min(1)
    .max(200)
    .refine(
      (ms) => ms.filter((m) => m.kind === "send_sms").length <= MAX_SMS_PER_PLAN,
      {
        message: `a plan may contain at most ${MAX_SMS_PER_PLAN} send_sms mutations`,
      }
    ),
})

export type ApplyPlanResult =
  | { ok: true; results: AppliedMutation[] }
  | { ok: false; error: string }

export async function applyPlanAction(input: {
  mutations: ProposedMutation[]
}): Promise<ApplyPlanResult> {
  // Important: never `throw` from this action. Thrown errors get their
  // message scrubbed by Next.js in production builds and surface to the
  // client as the generic "Server Components render" digest, which is
  // useless for the user. Return typed errors instead so the dialog can
  // show the real reason a plan didn't apply.
  const profile = await requireStaff()
  const parsed = ApplyInputSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const detail = issue
      ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
      : "unknown"
    // Server-side log so we can correlate with a stack trace in Vercel
    // logs if the user reports the same error twice.
    console.warn("[applyPlanAction] payload rejected:", detail, parsed.error.issues)
    return {
      ok: false,
      error: `Invalid plan payload — ${detail}. This is usually because the agent fabricated an ID or a date format the database can't store; refining the prompt and re-running often fixes it.`,
    }
  }
  const supabase = await createSupabaseServerClient()
  const results = await applyPlanInternal(
    supabase,
    parsed.data.mutations,
    profile.id
  )
  if (results.some((r) => r.ok)) {
    // Only some mutation kinds carry the project_id on the wire; the
    // schedule_item-scoped ones (add_checklist_item, update_schedule_item*)
    // and decision-scoped ones (update_decision_status,
    // add_decision_followup) reference the row by id alone. For a clean
    // per-project revalidation we'd need a lookup per affected row.
    // Instead: gather every project_id we DO know, and fall back to a
    // broad layout revalidation if any mutation kind lacked one. This is
    // still strictly better than the old unconditional broad revalidate
    // when every mutation in the plan is a `create_*`.
    const projectIds = new Set<string>()
    let needsBroadRevalidate = false
    for (const r of results) {
      if (!r.ok) continue
      const m = r.mutation
      switch (m.kind) {
        case "create_todo":
        case "create_work_item":
        case "create_decision":
        case "append_daily_log":
          projectIds.add(m.project_id)
          break
        case "send_sms":
          // Nothing in the DB changed — no revalidation needed.
          break
        default:
          needsBroadRevalidate = true
      }
    }
    if (needsBroadRevalidate) {
      revalidatePath("/projects", "layout")
    } else {
      for (const pid of projectIds) {
        revalidatePath(`/projects/${pid}`, "layout")
      }
    }
  }
  return { ok: true, results }
}
