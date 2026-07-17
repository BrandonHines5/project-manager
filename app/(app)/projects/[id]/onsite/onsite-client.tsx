"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input, Field, Select, Textarea } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import {
  answerCompletion,
  answerStart,
  type OnsiteAnswerResult,
} from "@/app/actions/onsite"
import { sendQuoTextToSub } from "@/app/actions/schedule"
import type { OnsitePrompt } from "@/lib/onsite/prompts"
import { formatDate, todayISO } from "@/lib/utils"

const TRIGGER_LABEL: Record<OnsitePrompt["trigger"], string> = {
  past_due: "Past due",
  ending_today: "Ending today",
  starting_today: "Starting today",
  upcoming_unstarted: "Upcoming",
  todo_past_due: "To-do past due",
  todo_due_today: "To-do due today",
}
const TRIGGER_TONE: Record<
  OnsitePrompt["trigger"],
  "danger" | "warning" | "brand" | "muted"
> = {
  past_due: "danger",
  ending_today: "warning",
  starting_today: "brand",
  upcoming_unstarted: "muted",
  todo_past_due: "danger",
  todo_due_today: "warning",
}

export function OnsiteClient({
  projectId,
  projectAddress,
  prompts: initialPrompts,
}: {
  projectId: string
  projectAddress: string | null
  prompts: OnsitePrompt[]
}) {
  const [prompts, setPrompts] = useState(initialPrompts)

  if (prompts.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-8 w-8" />}
        title="All caught up"
        description="No schedule items need an update right now."
      />
    )
  }
  return (
    <div className="space-y-3">
      {prompts.map((p) => (
        <PromptCard
          key={p.id}
          prompt={p}
          projectId={projectId}
          projectAddress={projectAddress}
          onResolved={() =>
            setPrompts((cur) => cur.filter((x) => x.id !== p.id))
          }
        />
      ))}
    </div>
  )
}

function PromptCard({
  prompt,
  projectId,
  projectAddress,
  onResolved,
}: {
  prompt: OnsitePrompt
  projectId: string
  projectAddress: string | null
  onResolved: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState<null | "already_done" | "new_end_date" | "new_start_date">(null)
  const [dateValue, setDateValue] = useState<string>(todayISO())

  function run(action: () => Promise<OnsiteAnswerResult>) {
    setError(null)
    startTransition(async () => {
      try {
        const res = await action()
        if (!res.ok) {
          setError(res.error)
          return
        }
        onResolved()
        // A cascade can change sibling prompts' question text (e.g. a
        // past_due item's quoted end_date). router.refresh pulls fresh
        // server data so neighbouring cards aren't stale.
        router.refresh()
      } catch {
        setError("Couldn't save your update. Please try again.")
      }
    })
  }

  const isCompletionPrompt =
    prompt.trigger === "past_due" ||
    prompt.trigger === "ending_today" ||
    prompt.trigger === "todo_past_due" ||
    prompt.trigger === "todo_due_today"
  const isStartPrompt =
    prompt.trigger === "starting_today" ||
    prompt.trigger === "upcoming_unstarted"
  // Work items and to-dos use different date columns and slightly different
  // copy; the underlying action handles the column choice, we just label.
  const isTodo = prompt.kind === "todo"
  const completionDateLabel = isTodo ? "due date" : "end date"
  const yesTodayLabel = isTodo ? "Yes, done today" : "Yes, completing today"
  const completionDateAnchor = isTodo ? prompt.due_date : prompt.end_date

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Badge tone={TRIGGER_TONE[prompt.trigger]}>
          {TRIGGER_LABEL[prompt.trigger]}
        </Badge>
        <CardTitle className="text-sm font-medium">{prompt.title}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm">{prompt.question}</p>

        {picking ? (
          <DatePickerRow
            label={
              picking === "already_done"
                ? isTodo
                  ? "What date did it actually get done?"
                  : "What date did it actually complete?"
                : picking === "new_end_date"
                  ? isTodo
                    ? "What's the new due date?"
                    : "What's the new end date?"
                  : "What's the new start date?"
            }
            value={dateValue}
            onChange={setDateValue}
            onCancel={() => setPicking(null)}
            disabled={pending}
            onSubmit={() => {
              if (picking === "already_done") {
                run(() =>
                  answerCompletion({
                    schedule_item_id: prompt.id,
                    project_id: projectId,
                    answer: "already_done",
                    actual_end_date: dateValue,
                  })
                )
              } else if (picking === "new_end_date") {
                run(() =>
                  answerCompletion({
                    schedule_item_id: prompt.id,
                    project_id: projectId,
                    answer: "new_end_date",
                    new_end_date: dateValue,
                  })
                )
              } else {
                run(() =>
                  answerStart({
                    schedule_item_id: prompt.id,
                    project_id: projectId,
                    answer: "new_start_date",
                    new_start_date: dateValue,
                  })
                )
              }
            }}
          />
        ) : isCompletionPrompt ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  answerCompletion({
                    schedule_item_id: prompt.id,
                    project_id: projectId,
                    answer: "yes_today",
                  })
                )
              }
            >
              {yesTodayLabel}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setDateValue(completionDateAnchor ?? todayISO())
                setPicking("already_done")
              }}
            >
              Already done on&hellip;
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setDateValue(todayISO())
                setPicking("new_end_date")
              }}
            >
              No, new {completionDateLabel}&hellip;
            </Button>
          </div>
        ) : isStartPrompt ? (
          <div className="flex flex-wrap gap-2">
            {prompt.trigger === "starting_today" && (
              <Button
                  disabled={pending}
                onClick={() =>
                  run(() =>
                    answerStart({
                      schedule_item_id: prompt.id,
                      project_id: projectId,
                      answer: "yes",
                    })
                  )
                }
              >
                Yes, started
              </Button>
            )}
            {prompt.trigger === "upcoming_unstarted" && (
              <Button
                  variant="secondary"
                disabled={pending}
                onClick={onResolved}
              >
                On track — dismiss
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setDateValue(prompt.start_date ?? todayISO())
                setPicking("new_start_date")
              }}
            >
              No, new start date&hellip;
            </Button>
          </div>
        ) : null}

        {prompt.recipients.length > 0 && (
          <TextAssigneePanel prompt={prompt} projectAddress={projectAddress} />
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </CardBody>
    </Card>
  )
}

// Prefilled per-trigger nudge so the staffer only has to hit Send. Late
// items ask for status; today/upcoming items confirm the plan.
function buildPromptText(
  prompt: OnsitePrompt,
  projectAddress: string | null
): string {
  const where = projectAddress?.trim() || "the job site"
  const title = `"${prompt.title}" at ${where}`
  switch (prompt.trigger) {
    case "past_due":
      return `Hines Homes: checking on ${title} — it was scheduled to finish ${formatDate(prompt.end_date)}. What's the status?`
    case "todo_past_due":
      return `Hines Homes: checking on ${title} — it was due ${formatDate(prompt.due_date)}. What's the status?`
    case "ending_today":
      return `Hines Homes: ${title} is scheduled to finish today. Will it wrap up today?`
    case "todo_due_today":
      return `Hines Homes: ${title} is due today. Will it get done today?`
    case "starting_today":
      return `Hines Homes: ${title} is scheduled to start today. Are you set to be on site?`
    case "upcoming_unstarted":
      return `Hines Homes: ${title} is scheduled to start ${formatDate(prompt.start_date)}. Still on track?`
  }
}

/**
 * "Text assignee" for a quick-update card: texts the sub/vendor behind the
 * item's saved assignments (direct company, or the company filling an
 * assigned role) via the same server action as the schedule dialog — the
 * server re-verifies the assignment and resolves the role, so this can only
 * reach companies actually on the item.
 */
function TextAssigneePanel({
  prompt,
  projectAddress,
}: {
  prompt: OnsitePrompt
  projectAddress: string | null
}) {
  const [open, setOpen] = useState(false)
  const [recipientKey, setRecipientKey] = useState(
    prompt.recipients[0]?.key ?? ""
  )
  const [message, setMessage] = useState("")
  const [pending, startTransition] = useTransition()

  const selected =
    prompt.recipients.find((r) => r.key === recipientKey) ??
    prompt.recipients[0] ??
    null

  function openPanel() {
    if (!prompt.recipients[0]) return
    setRecipientKey(selected?.key ?? prompt.recipients[0].key)
    setMessage(buildPromptText(prompt, projectAddress))
    setOpen(true)
  }

  function send() {
    if (!selected || !message.trim()) return
    startTransition(async () => {
      try {
        const res = await sendQuoTextToSub({
          schedule_item_id: prompt.id,
          message: message.trim(),
          ...(selected.target.kind === "company"
            ? { company_id: selected.target.company_id }
            : { role_id: selected.target.role_id }),
        })
        if (res.ok) {
          toast.success(`Text sent to ${res.company_name}`)
          setOpen(false)
        } else {
          toast.error(res.error)
        }
      } catch (e) {
        console.error("sendQuoTextToSub threw:", e)
        toast.error("Couldn't send text. Try again, or check the server logs.")
      }
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline cursor-pointer"
      >
        <MessageSquare className="h-3 w-3" />
        Text {selected?.label ?? "assignee"}
      </button>
    )
  }
  return (
    <div className="p-3 bg-brand-50/60 border border-brand-200 rounded-md space-y-2">
      {prompt.recipients.length > 1 && (
        <Field label="Recipient" htmlFor={`onsite-recipient-${prompt.id}`}>
          <Select
            id={`onsite-recipient-${prompt.id}`}
            value={recipientKey}
            onChange={(e) => setRecipientKey(e.target.value)}
          >
            {prompt.recipients.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
                {r.phone ? "" : " (no phone on file)"}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {selected && !selected.phone && (
        <p className="text-xs text-danger">
          {selected.companyName} has no phone number on file. Add one on the
          company profile before sending.
        </p>
      )}
      <Field
        label="Message"
        htmlFor={`onsite-message-${prompt.id}`}
        hint={`${message.length} / 1600`}
      >
        <Textarea
          id={`onsite-message-${prompt.id}`}
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, 1600))}
          rows={3}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={send}
          disabled={pending || !selected?.phone || !message.trim()}
        >
          {pending ? "Sending…" : "Send text"}
        </Button>
      </div>
    </div>
  )
}

function DatePickerRow({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={label} className="flex-1 min-w-[180px]">
        <Input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      </Field>
      <Button disabled={disabled || !value} onClick={onSubmit}>
        Save
      </Button>
      <Button variant="ghost" disabled={disabled} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}
