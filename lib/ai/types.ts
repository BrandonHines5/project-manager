// Types shared between the AI agent server action and its client UI.

// A single mutation the agent proposes during planning. The agent calls one
// of the propose_* tools to add an entry to the plan; nothing executes until
// the user reviews and approves.
//
// Keep this union narrow on purpose — every new mutation kind needs a
// matching apply path AND a matching propose_* tool. Ship the v1 list, then
// add deliberately.
export type ProposedMutation =
  | {
      kind: "add_checklist_item"
      schedule_item_id: string
      label: string
      // Context the UI shows next to each plan row. Computed by the tool at
      // proposal time so the user sees the human-readable target without
      // another lookup.
      context: {
        project_name: string
        project_number: string
        item_title: string
      }
    }
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

export type AgentTurnResult =
  | {
      type: "plan"
      // Free-text explanation the model produced as its final text response.
      summary: string
      mutations: ProposedMutation[]
    }
  | {
      type: "question"
      // The model called ask_user — surface the question, collect a reply,
      // then call runAgentTurn again with the updated conversation.
      question: string
    }
  | {
      type: "error"
      message: string
    }

// Apply-phase result, one entry per attempted mutation.
export type AppliedMutation = {
  mutation: ProposedMutation
  ok: boolean
  error?: string
}
