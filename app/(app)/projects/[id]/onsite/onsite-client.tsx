"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2 } from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input, Field } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import {
  answerCompletion,
  answerStart,
  type OnsiteAnswerResult,
} from "@/app/actions/onsite"
import type { OnsitePrompt } from "@/lib/onsite/prompts"
import { todayISO } from "@/lib/utils"

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
  prompts: initialPrompts,
}: {
  projectId: string
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
  onResolved,
}: {
  prompt: OnsitePrompt
  projectId: string
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
              size="sm"
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
              size="sm"
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
              size="sm"
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
                size="sm"
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
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={onResolved}
              >
                On track — dismiss
              </Button>
            )}
            <Button
              size="sm"
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

        {error && <p className="text-sm text-danger">{error}</p>}
      </CardBody>
    </Card>
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
      <Button size="sm" disabled={disabled || !value} onClick={onSubmit}>
        Save
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}
