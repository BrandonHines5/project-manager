"use client"

// Shared renderers for AI agent plans: the mutation list a user reviews
// before applying, and the applied-results card. Used by the global AI
// dialog (components/layout/ai-agent.tsx) and the onsite walkthrough
// (components/onsite/walkthrough.tsx).

import {
  CheckCircle2,
  XCircle,
  ListChecks,
  Plus,
  Pencil,
  Calendar,
  Scale,
  Palette,
  Send as SendIcon,
  UserPlus,
  Users,
  MessageSquare,
  MailQuestion,
  NotebookPen,
  Image as ImageIcon,
  AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProposedMutation, AppliedMutation } from "@/lib/ai/types"

export function PlanCard({
  mutations,
  className,
  selection,
  incomplete,
}: {
  mutations: ProposedMutation[]
  // Extra classes for the list container (the dialog caps its height and
  // scrolls; the onsite page lets the page scroll instead).
  className?: string
  // When present, each row gets a leading checkbox — the onsite walkthrough
  // lets the user apply a subset of the plan. Absent = plain list (dialog).
  selection?: { checked: boolean[]; onToggle: (index: number) => void }
  // Set when the agent turn was cut short — the plan may be missing its tail.
  incomplete?: "max_tokens" | "iteration_cap"
}) {
  return (
    <div className="rounded-md border border-border-strong bg-surface">
      <div className="px-3 py-2 border-b border-border bg-background/60 text-xs uppercase tracking-wide text-muted flex items-center gap-1.5">
        <ListChecks className="h-3.5 w-3.5" />
        Plan — {mutations.length} change{mutations.length === 1 ? "" : "s"}
      </div>
      {incomplete && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-amber-200 bg-amber-50 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>
            This plan may be incomplete
            {incomplete === "max_tokens"
              ? " — the response was cut off"
              : " — the request hit the step limit"}
            . Review carefully, or refine your prompt and re-run for the full
            set of changes.
          </span>
        </div>
      )}
      <ul className={cn("divide-y divide-border", className)}>
        {mutations.map((m, i) => (
          <li key={i} className="px-3 py-2 text-sm">
            {selection ? (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selection.checked[i] ?? false}
                  onChange={() => selection.onToggle(i)}
                  // Generous hit area for gloved/one-handed taps on site.
                  className="mt-1 h-5 w-5 shrink-0 accent-brand-500 cursor-pointer"
                  aria-label="Include this change"
                />
                <div
                  className={cn(
                    "flex-1 min-w-0",
                    !selection.checked[i] && "opacity-60"
                  )}
                >
                  <MutationRow mutation={m} />
                </div>
              </label>
            ) : (
              <MutationRow mutation={m} />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MutationRow({
  mutation,
}: {
  mutation: ProposedMutation
}): React.ReactNode {
  // Project crumb shared by every row.
  const crumb = (parts: { project_name: string; project_number: string }) => (
    <div className="text-xs text-muted mt-0.5">
      {parts.project_name}{" "}
      {parts.project_number && (
        <span className="font-mono">#{parts.project_number}</span>
      )}
    </div>
  )

  switch (mutation.kind) {
    case "add_checklist_item":
      return (
        <RowFrame icon={<ListChecks className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Add checklist item:{" "}
            <span className="font-mono text-xs">&ldquo;{mutation.label}&rdquo;</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.item_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_schedule_item_status":
      return (
        <RowFrame
          icon={<Pencil className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Set status:{" "}
            <span className="font-mono text-xs">
              {mutation.context.previous_status}
            </span>{" "}
            → <span className="font-mono text-xs">{mutation.status}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.item_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_schedule_item":
      return (
        <RowFrame
          icon={<Pencil className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Update item: {mutation.context.item_title}
          </div>
          <ul className="text-xs mt-1 space-y-0.5">
            {mutation.context.changes.map((c, i) => (
              <li key={i} className="font-mono">
                {c}
              </li>
            ))}
          </ul>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "create_todo":
      return (
        <RowFrame icon={<Plus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            New to-do: <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.parent_title
              ? `under ${mutation.context.parent_title} · `
              : ""}
            {mutation.due_date && (
              <span>
                <Calendar className="inline h-3 w-3 mr-0.5" />
                {mutation.due_date} ·{" "}
              </span>
            )}
            {mutation.context.assignee_name && (
              <span>assigned to {mutation.context.assignee_name} · </span>
            )}
            {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "assign_schedule_item":
      return (
        <RowFrame icon={<Users className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Assign to {mutation.context.assignee_name}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.item_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "create_work_item":
      return (
        <RowFrame icon={<Plus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            New work item:{" "}
            <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            <Calendar className="inline h-3 w-3 mr-0.5" />
            {mutation.start_date} → {mutation.end_date} ·{" "}
            {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "create_decision":
      return (
        <RowFrame
          icon={
            mutation.decision_kind === "change_order" ? (
              <Scale className="h-3.5 w-3.5 text-brand-500" />
            ) : (
              <Palette className="h-3.5 w-3.5 text-brand-500" />
            )
          }
        >
          <div className="font-medium">
            New{" "}
            {mutation.decision_kind === "change_order"
              ? "change order"
              : "selection"}
            : <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            (starts as draft) · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_decision_status":
      return (
        <RowFrame
          icon={<SendIcon className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Decision #{mutation.context.decision_number}: status{" "}
            <span className="font-mono text-xs">
              {mutation.context.previous_status}
            </span>{" "}
            → <span className="font-mono text-xs">{mutation.status}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.decision_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "add_decision_followup":
      return (
        <RowFrame icon={<UserPlus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Add follow-up:{" "}
            <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            on Decision #{mutation.context.decision_number} (
            {mutation.context.decision_title}) · due{" "}
            {mutation.due_offset_days}d after approval
            {mutation.context.assignee_name &&
              ` · assigned to ${mutation.context.assignee_name}`}
          </div>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "append_daily_log":
      return (
        <RowFrame icon={<NotebookPen className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Daily log note ({mutation.log_date})
            <span className="font-normal text-xs text-muted">
              {" "}
              —{" "}
              {mutation.context.appends_to_existing
                ? "adds to the existing log"
                : "starts a new internal log"}
            </span>
          </div>
          <div className="text-xs mt-1 whitespace-pre-wrap">
            {mutation.note}
          </div>
          {mutation.attachments && mutation.attachments.length > 0 && (
            <div className="text-xs text-muted mt-0.5 flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />+{mutation.attachments.length}{" "}
              photo{mutation.attachments.length === 1 ? "" : "s"} attached
            </div>
          )}
          {mutation.subs_on_site && mutation.subs_on_site.length > 0 && (
            <div className="text-xs text-muted mt-0.5 flex items-center gap-1 flex-wrap">
              <Users className="h-3 w-3" />
              On site:{" "}
              {mutation.subs_on_site.map((s) => s.company_name).join(", ")}
            </div>
          )}
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "send_bid_reminder":
      return (
        <RowFrame
          icon={<MailQuestion className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Bid reminder — {mutation.context.package_title} (#
            {mutation.context.package_number})
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.recipient_names.length > 0
              ? `reminding ${mutation.context.recipient_names.join(", ")}`
              : `reminding ${mutation.company_ids.length} recipient${mutation.company_ids.length === 1 ? "" : "s"}`}
          </div>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "send_sms":
      return (
        <RowFrame
          icon={<MessageSquare className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Text {mutation.context.company_name}{" "}
            <span className="font-mono text-xs">
              {mutation.context.company_phone}
            </span>
          </div>
          <div className="text-xs mt-1 whitespace-pre-wrap">
            &ldquo;{mutation.message}&rdquo;
          </div>
          {mutation.context.project_name && (
            <div className="text-xs text-muted mt-0.5">
              {mutation.context.project_name}{" "}
              {mutation.context.project_number && (
                <span className="font-mono">
                  #{mutation.context.project_number}
                </span>
              )}
            </div>
          )}
        </RowFrame>
      )
    default: {
      // Compiler-enforced exhaustiveness: adding a ProposedMutation kind
      // without a row here becomes a type error instead of a silently
      // blank plan row.
      const exhaustive: never = mutation
      return exhaustive
    }
  }
}

export function RowFrame({
  icon,
  children,
  destructive,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  destructive?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "h-5 w-5 rounded flex items-center justify-center mt-0.5 shrink-0",
          destructive ? "bg-amber-100" : "bg-brand-100"
        )}
        title={destructive ? "Modifies existing data" : "Additive"}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

export function AppliedCard({ results }: { results: AppliedMutation[] }) {
  const okCount = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-success/40 bg-green-50 px-3 py-2 text-sm flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
        <span>
          Applied {okCount} of {results.length} change
          {results.length === 1 ? "" : "s"}.
        </span>
      </div>
      {failed.length > 0 && (
        <div className="rounded-md border border-danger/40 bg-red-50">
          <div className="px-3 py-1.5 text-xs uppercase tracking-wide text-danger border-b border-danger/30 flex items-center gap-1.5">
            <XCircle className="h-3.5 w-3.5" />
            {failed.length} failure{failed.length === 1 ? "" : "s"}
          </div>
          <ul className="divide-y divide-danger/20 text-sm">
            {failed.map((r, i) => (
              <li key={i} className="px-3 py-2">
                <MutationRow mutation={r.mutation} />
                <div className="mt-1 text-xs text-danger font-mono">
                  {r.error}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
