"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { runAgentTurn, type OnsiteProjectContext } from "@/lib/ai/agent"
import { applyPlan as applyPlanInternal } from "@/lib/ai/apply"
import type { AgentTurnResult, AppliedMutation, ProposedMutation } from "@/lib/ai/types"
import type { Json } from "@/lib/db/types"
import type Anthropic from "@anthropic-ai/sdk"

// The conversation is stored client-side and shipped in full on every turn.
// We only allow user + assistant messages (no tool_use / tool_result blocks
// in the inbound payload — those are generated server-side and don't need
// to round-trip through the client). This keeps the wire surface small AND
// prevents a tampered client from injecting fake tool results.
const ClientMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  // 20k chars ≈ 20 minutes of dictation — a long onsite walkthrough fits in
  // one message. Still a trivial token count for the model.
  content: z.string().min(1).max(20000),
})
// A walkthrough photo the browser already uploaded to the project-files
// bucket. The server injects these into the plan's append_daily_log — the
// model never sees them.
const AttachmentInputSchema = z.object({
  storage_path: z.string().min(1).max(500),
  file_name: z.string().min(1).max(300),
  file_type: z.string().max(100).nullable(),
  file_size: z.number().int().min(0).max(50_000_000).nullable(),
  caption: z.string().max(500).nullable(),
})
// Onsite walkthrough turns carry the project the user is standing at. Only
// the id is trusted as a claim — the action re-resolves the project row
// under the caller's session, which both validates access and supplies the
// name/number the prompt needs.
const OnsiteContextSchema = z.object({
  project_id: z.string().uuid(),
  attachments: z.array(AttachmentInputSchema).max(30).default([]),
  // "onsite" = walkthrough (photos auto-attach); "page" = the global dialog
  // auto-scoped to the project route the user is viewing (no photos).
  mode: z.enum(["onsite", "page"]).default("onsite"),
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
  context: OnsiteContextSchema.optional(),
})
type ClientMessage = z.infer<typeof ClientMessageSchema>
// Input type (not output): `attachments` and `mode` have Zod defaults, so
// callers may omit them — the walkthrough sends only project_id+attachments,
// the auto-scoped dialog sends project_id+attachments+mode.
type OnsiteContextInput = z.input<typeof OnsiteContextSchema>

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

// Resolve a project id (parsed from the route the user is viewing) to its
// name/number for the "Scoped to …" chip in the global AI dialog. Runs under
// the caller's session so RLS both authorizes the scope and supplies the
// display fields; returns null for an unknown/forbidden id.
export async function getScopedProject(
  projectId: string
): Promise<{ id: string; name: string; project_number: string } | null> {
  await requireStaff()
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId
    )
  ) {
    return null
  }
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase
    .from("projects")
    .select("id, name, project_number")
    .eq("id", projectId)
    .maybeSingle()
  return data ?? null
}

export async function runAgentTurnAction(input: {
  messages: ClientMessage[]
  today?: string
  context?: OnsiteContextInput
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
  const today = parsed.data.today ?? new Date().toISOString().slice(0, 10)

  // Resolve the onsite project under the caller's session — RLS makes this
  // both an access check and the source of the trusted name/number the
  // system prompt cites. A client-supplied name is never used.
  let projectContext: OnsiteProjectContext | null = null
  const context = parsed.data.context
  if (context) {
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, name, project_number, address")
      .eq("id", context.project_id)
      .maybeSingle()
    if (error) {
      return { type: "error", message: `Failed to load project: ${error.message}` }
    }
    if (!project) {
      return { type: "error", message: "Project not found or not permitted." }
    }
    projectContext = { ...project, mode: context.mode }
  }

  try {
    const { result } = await runAgentTurn({
      messages: toClaudeMessages(parsed.data.messages),
      supabase,
      apiKey,
      today,
      projectContext,
    })
    if (
      result.type === "plan" &&
      context &&
      projectContext &&
      context.attachments.length > 0
    ) {
      await attachWalkthroughPhotos(
        supabase,
        result,
        projectContext,
        context.attachments,
        today
      )
    }
    return result
  } catch (e) {
    return {
      type: "error",
      message: e instanceof Error ? e.message : "Agent failed",
    }
  }
}

// Walkthrough photos ride the plan's append_daily_log mutation for the
// onsite project. Injected server-side — deterministic regardless of what
// the model proposed. If the plan somehow lacks a daily-log entry for the
// project (or the walkthrough was photos-only), synthesize one so "photos
// always land on the daily log" is a guarantee, not a prompt hope.
async function attachWalkthroughPhotos(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  plan: Extract<AgentTurnResult, { type: "plan" }>,
  project: { id: string; name: string; project_number: string },
  attachments: z.infer<typeof AttachmentInputSchema>[],
  today: string
): Promise<void> {
  const target = plan.mutations.find(
    (m): m is Extract<ProposedMutation, { kind: "append_daily_log" }> =>
      m.kind === "append_daily_log" && m.project_id === project.id
  )
  if (target) {
    target.attachments = attachments
    return
  }
  // appends_to_existing is a display hint only (apply re-checks), so a
  // transient lookup failure must not sink the whole turn — the plan it
  // decorates already cost an LLM call and the user's walkthrough.
  let appendsToExisting = false
  try {
    const { data: existing } = await supabase
      .from("daily_logs")
      .select("id")
      .eq("project_id", project.id)
      .eq("log_date", today)
      .limit(1)
    appendsToExisting = (existing?.length ?? 0) > 0
  } catch {
    // Best-effort — default to "new log" wording.
  }
  plan.mutations.push({
    kind: "append_daily_log",
    project_id: project.id,
    log_date: today,
    note: "Site walkthrough — photos attached.",
    attachments,
    context: {
      project_name: project.name,
      project_number: project.project_number,
      appends_to_existing: appendsToExisting,
    },
  })
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
    assignee_profile_id: z.string().uuid().nullable(),
    assignee_company_id: z.string().uuid().nullable(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      parent_title: z.string().nullable(),
      assignee_name: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal("assign_schedule_item"),
    schedule_item_id: z.string().uuid(),
    assignee_profile_id: z.string().uuid().nullable(),
    assignee_company_id: z.string().uuid().nullable(),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      item_title: z.string(),
      assignee_name: z.string(),
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
    // Walkthrough photos (server-injected at plan time). Apply enforces the
    // storage-path prefix, so validation here stays structural.
    attachments: z.array(AttachmentInputSchema).max(30).optional(),
    subs_on_site: z
      .array(
        z.object({
          company_id: z.string().uuid(),
          company_name: z.string(),
          notes: z.string().max(2000).nullable(),
        })
      )
      .max(50)
      .optional(),
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
  z.object({
    kind: z.literal("send_bid_reminder"),
    bid_package_id: z.string().uuid(),
    company_ids: z.array(z.string().uuid()).min(1).max(25),
    context: z.object({
      project_name: z.string(),
      project_number: z.string(),
      package_number: z.number(),
      package_title: z.string(),
      recipient_names: z.array(z.string()),
    }),
  }),
])
// A plan is capped at 200 mutations overall, but anything that leaves the
// building needs a tighter cap — a tampered payload with 200 send_sms /
// send_bid_reminder entries would be a texting cannon. Field notes
// realistically message at most a handful of subs per apply.
const MAX_SMS_PER_PLAN = 5
// Bid reminders fan out per RECIPIENT (each gets an email and possibly an
// SMS), so the cap counts total recipients across every send_bid_reminder
// in the plan — not mutation rows. 25 covers reminding every open package
// on a job without becoming a messaging cannon.
const MAX_BID_REMINDER_RECIPIENTS_PER_PLAN = 25
const ApplyInputSchema = z.object({
  // Server-generated per-turn UUID (from the plan result). Used as an
  // idempotency key so re-applying the same plan can't duplicate writes.
  plan_id: z.string().uuid(),
  // The plan's summary, stored on the audit row. Optional — the walkthrough
  // and dialog both send it, but a tampered payload may omit it.
  summary: z.string().max(20000).optional(),
  mutations: z
    .array(MutationSchema)
    .min(1)
    .max(200)
    .refine(
      (ms) => ms.filter((m) => m.kind === "send_sms").length <= MAX_SMS_PER_PLAN,
      {
        message: `a plan may contain at most ${MAX_SMS_PER_PLAN} send_sms mutations`,
      }
    )
    .refine(
      (ms) =>
        ms.reduce(
          (sum, m) =>
            sum + (m.kind === "send_bid_reminder" ? m.company_ids.length : 0),
          0
        ) <= MAX_BID_REMINDER_RECIPIENTS_PER_PLAN,
      {
        message: `a plan may remind at most ${MAX_BID_REMINDER_RECIPIENTS_PER_PLAN} bid recipients in total`,
      }
    ),
})

export type ApplyPlanResult =
  | { ok: true; results: AppliedMutation[]; alreadyApplied?: boolean }
  | { ok: false; error: string }

export async function applyPlanAction(input: {
  mutations: ProposedMutation[]
  plan_id: string
  summary?: string
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

  // Idempotency + audit: claim the plan_id BEFORE applying. The unique
  // constraint on ai_plan_applications.plan_id means a second apply of the
  // same plan (a double-click, or the walkthrough's blind retry after a
  // network error) loses the race and returns the FIRST apply's results
  // instead of re-running — critical for send_sms / send_bid_reminder, which
  // can't be un-sent. The claim row also becomes the permanent audit trail.
  let auditEnabled = true
  const { error: claimErr } = await supabase.from("ai_plan_applications").insert({
    plan_id: parsed.data.plan_id,
    applied_by: profile.id,
    summary: parsed.data.summary ?? null,
    mutations: parsed.data.mutations as unknown as Json,
    results: null,
    applied_count: 0,
    failed_count: 0,
  })
  if (claimErr) {
    // Migration 0071 not applied yet (e.g. a preview deploy before the DB
    // migration runs): degrade gracefully — apply without the idempotency
    // guard / audit trail rather than blocking every apply. Self-heals once
    // the table exists.
    if ((claimErr as { code?: string }).code === "42P01") {
      console.warn(
        "[applyPlanAction] ai_plan_applications missing — apply proceeding without idempotency/audit. Apply migration 0071."
      )
      auditEnabled = false
    } else if ((claimErr as { code?: string }).code === "23505") {
      // Already applied (or applying) — return the stored per-mutation
      // results rather than an opaque error, so an honest retry sees what
      // the first apply did.
      const { data: prior } = await supabase
        .from("ai_plan_applications")
        .select("results")
        .eq("plan_id", parsed.data.plan_id)
        .maybeSingle()
      const priorResults = prior?.results as AppliedMutation[] | null
      if (priorResults && Array.isArray(priorResults)) {
        return { ok: true, results: priorResults, alreadyApplied: true }
      }
      return {
        ok: false,
        error:
          "This plan was already applied. Refine the prompt and re-run to make further changes.",
      }
    } else {
      console.warn("[applyPlanAction] claim insert failed:", claimErr.message)
      return {
        ok: false,
        error: `Could not record the plan before applying: ${claimErr.message}`,
      }
    }
  }

  const results = await applyPlanInternal(
    supabase,
    parsed.data.mutations,
    profile.id
  )

  // Record the outcome on the audit row. Best-effort — the writes already
  // landed, so a failed audit update shouldn't fail the apply. Skipped when
  // the audit table isn't present yet (see the 42P01 degrade above).
  if (auditEnabled) {
    const appliedCount = results.filter((r) => r.ok).length
    const { error: auditErr } = await supabase
      .from("ai_plan_applications")
      .update({
        results: results as unknown as Json,
        applied_count: appliedCount,
        failed_count: results.length - appliedCount,
      })
      .eq("plan_id", parsed.data.plan_id)
    if (auditErr) {
      console.warn("[applyPlanAction] audit update failed:", auditErr.message)
    }
  }

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
        case "send_bid_reminder":
          // Nothing user-facing in the DB changed — no revalidation needed.
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
