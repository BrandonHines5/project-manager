// Types shared between the AI agent server action and its client UI.

// A single mutation the agent proposes during planning. The agent calls one
// of the propose_* tools to add an entry to the plan; nothing executes until
// the user reviews and approves.
//
// Adding a new mutation kind takes five edits (kept in sync — see
// CLAUDE.md → "AI smart-update agent — model"):
//   1. extend this union
//   2. add the propose_* tool definition + handler in lib/ai/agent.ts
//   3. add the apply branch in lib/ai/apply.ts
//   4. add a case in components/ai/plan-review.tsx:MutationRow
//   5. add the Zod case in app/actions/ai-agent.ts:MutationSchema
//
// `is_destructive` (helper) below classifies which mutations require the
// typed-confirmation gate in the dialog footer.
// A photo captured during an onsite walkthrough, already uploaded to the
// project-files bucket by the browser. Attached to the daily log when the
// append_daily_log mutation applies. Never produced by the model — the
// server injects these into the plan from the walkthrough submission.
export type DailyLogPhotoAttachment = {
  // Must live under projects/{project_id}/daily-logs/ — apply rejects
  // anything else so a tampered plan can't link arbitrary bucket objects.
  storage_path: string
  file_name: string
  file_type: string | null
  file_size: number | null
  caption: string | null
}

export type ProposedMutation =
  // ---- Additive (no typed confirmation) ----
  | {
      kind: "add_checklist_item"
      schedule_item_id: string
      label: string
      context: {
        project_name: string
        project_number: string
        item_title: string
      }
    }
  | {
      kind: "create_todo"
      project_id: string
      title: string
      description: string | null
      due_date: string | null
      parent_id: string | null
      // Optional assignee — exactly one of profile/company, or neither.
      // Applied as a schedule_assignments row after the to-do is created.
      assignee_profile_id: string | null
      assignee_company_id: string | null
      context: {
        project_name: string
        project_number: string
        parent_title: string | null
        assignee_name: string | null
      }
    }
  | {
      // Add an assignment to an EXISTING schedule item (work or todo).
      // Exactly one of profile/company. Idempotent on apply (skips if the
      // same assignee is already on the item).
      kind: "assign_schedule_item"
      schedule_item_id: string
      assignee_profile_id: string | null
      assignee_company_id: string | null
      context: {
        project_name: string
        project_number: string
        item_title: string
        assignee_name: string
      }
    }
  | {
      kind: "create_work_item"
      project_id: string
      title: string
      description: string | null
      start_date: string
      end_date: string
      context: {
        project_name: string
        project_number: string
      }
    }
  | {
      kind: "create_decision"
      project_id: string
      decision_kind: "change_order" | "selection"
      title: string
      description: string | null
      context: {
        project_name: string
        project_number: string
      }
    }
  | {
      kind: "add_decision_followup"
      decision_id: string
      title: string
      due_offset_days: number
      assignee_profile_id: string | null
      assignee_company_id: string | null
      context: {
        project_name: string
        project_number: string
        decision_number: number
        decision_title: string
        assignee_name: string | null
      }
    }
  | {
      kind: "append_daily_log"
      project_id: string
      // YYYY-MM-DD. Apply appends to the most recent log for this project +
      // date, or creates a new internal log when none exists.
      log_date: string
      note: string
      // Walkthrough photos to link to the log (server-injected; absent for
      // plans from the global dialog).
      attachments?: DailyLogPhotoAttachment[]
      // Subs/vendors that were on site, recorded structurally in
      // daily_log_subs_on_site (not just as prose in the note). company_name
      // is resolved at propose time for the review UI; apply uses company_id.
      subs_on_site?: {
        company_id: string
        company_name: string
        notes: string | null
      }[]
      context: {
        project_name: string
        project_number: string
        // Whether a log already existed for this date at proposal time —
        // display hint only; apply re-checks.
        appends_to_existing: boolean
      }
    }
  // ---- Destructive (typed confirmation required) ----
  | {
      kind: "update_schedule_item_status"
      schedule_item_id: string
      status: "not_started" | "in_progress" | "complete" | "delayed"
      context: {
        project_name: string
        project_number: string
        item_title: string
        previous_status: string
      }
    }
  | {
      kind: "update_schedule_item"
      schedule_item_id: string
      // Patch — only included fields are updated. Each must be valid for the
      // item's kind (start/end for work, due_date for todo). Validated at
      // apply time.
      patch: {
        title?: string
        description?: string | null
        start_date?: string | null
        end_date?: string | null
        due_date?: string | null
        parent_id?: string | null
      }
      context: {
        project_name: string
        project_number: string
        item_title: string
        // Human-readable diff for the plan UI: list of "field: old → new"
        // strings, computed at proposal time.
        changes: string[]
      }
    }
  | {
      kind: "update_decision_status"
      decision_id: string
      status: "draft" | "pending_client" | "approved" | "rejected"
      context: {
        project_name: string
        project_number: string
        decision_number: number
        decision_title: string
        previous_status: string
      }
    }
  | {
      kind: "send_sms"
      company_id: string
      message: string
      context: {
        company_name: string
        // Phone shown for review only — apply re-resolves the number from
        // the companies row so a tampered payload can't redirect the text.
        company_phone: string
        project_name: string | null
        project_number: string | null
      }
    }
  | {
      // Re-send a bid package's invite to recipients who were invited but
      // haven't responded. Apply reuses each recipient's existing token —
      // it never creates recipients or changes the package status.
      kind: "send_bid_reminder"
      bid_package_id: string
      company_ids: string[]
      context: {
        project_name: string
        project_number: string
        package_number: number
        package_title: string
        recipient_names: string[]
      }
    }

/**
 * Mutations that change existing data — or leave the building entirely,
 * like an SMS — need an extra confirmation step in the UI (type "apply"
 * to enable the button). Pure creates are additive and don't.
 */
export function isDestructive(m: ProposedMutation): boolean {
  return (
    m.kind === "update_schedule_item_status" ||
    m.kind === "update_schedule_item" ||
    m.kind === "update_decision_status" ||
    m.kind === "send_sms" ||
    m.kind === "send_bid_reminder"
  )
}

export type AgentTurnResult =
  | {
      type: "plan"
      // Server-generated per-turn UUID. Round-trips through the client and
      // is required at apply time as an idempotency key — re-applying the
      // same plan is a no-op that returns the first apply's results instead
      // of duplicating writes (or re-texting subs). See ai_plan_applications.
      plan_id: string
      summary: string
      mutations: ProposedMutation[]
      // Set when the turn was cut short: "max_tokens" (the model's response
      // was truncated) or "iteration_cap" (hit MAX_ITERATIONS). The plan may
      // be missing its tail — the UI warns before the user applies.
      incomplete?: "max_tokens" | "iteration_cap"
    }
  | {
      type: "question"
      question: string
    }
  | {
      type: "error"
      message: string
    }

export type AppliedMutation = {
  mutation: ProposedMutation
  ok: boolean
  error?: string
}
