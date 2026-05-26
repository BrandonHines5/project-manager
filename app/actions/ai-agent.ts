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
])
const ApplyInputSchema = z.object({
  mutations: z.array(MutationSchema).min(1).max(200),
})

export async function applyPlanAction(input: {
  mutations: ProposedMutation[]
}): Promise<{ results: AppliedMutation[] }> {
  await requireStaff()
  const parsed = ApplyInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      `Invalid plan payload: ${parsed.error.issues[0]?.message ?? "unknown"}`
    )
  }
  const supabase = await createSupabaseServerClient()
  const results = await applyPlanInternal(supabase, parsed.data.mutations)
  // We don't track project_id per mutation, and schedule pages are
  // server-rendered with `force-dynamic` anyway — revalidating the entire
  // /projects tree on any success is cheap and guarantees the user sees
  // their change after the dialog closes.
  if (results.some((r) => r.ok)) {
    revalidatePath("/projects", "layout")
  }
  return { results }
}
