"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, MapPin, MapPinOff, Loader2 } from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input, Field } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { useOnsite } from "@/lib/geolocation/use-onsite"
import { setProjectCoordinates } from "@/app/actions/projects"
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
}
const TRIGGER_TONE: Record<
  OnsitePrompt["trigger"],
  "danger" | "warning" | "brand" | "muted"
> = {
  past_due: "danger",
  ending_today: "warning",
  starting_today: "brand",
  upcoming_unstarted: "muted",
}

export function OnsiteClient({
  projectId,
  latitude,
  longitude,
  prompts: initialPrompts,
}: {
  projectId: string
  latitude: number | null
  longitude: number | null
  prompts: OnsitePrompt[]
}) {
  if (latitude == null || longitude == null) {
    return <CoordinatesSetup projectId={projectId} />
  }
  return (
    <OnsiteBody
      projectId={projectId}
      latitude={latitude}
      longitude={longitude}
      prompts={initialPrompts}
    />
  )
}

function OnsiteBody({
  projectId,
  latitude,
  longitude,
  prompts: initialPrompts,
}: {
  projectId: string
  latitude: number
  longitude: number
  prompts: OnsitePrompt[]
}) {
  const [override, setOverride] = useState(false)
  const [prompts, setPrompts] = useState(initialPrompts)
  const { state, distanceMeters, errorMessage, retry } = useOnsite({
    projectId,
    lat: latitude,
    lng: longitude,
  })

  const showPrompts = state === "onsite" || override

  return (
    <div className="space-y-4">
      <GeolocationBanner
        state={state}
        distanceMeters={distanceMeters}
        errorMessage={errorMessage}
        override={override}
        onRetry={retry}
        onOverride={() => setOverride(true)}
      />
      {showPrompts && prompts.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 className="h-8 w-8" />}
          title="All caught up"
          description="No schedule items need an update right now."
        />
      )}
      {showPrompts && prompts.length > 0 && (
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
      )}
    </div>
  )
}

function GeolocationBanner({
  state,
  distanceMeters,
  errorMessage,
  override,
  onRetry,
  onOverride,
}: {
  state: ReturnType<typeof useOnsite>["state"]
  distanceMeters: number | null
  errorMessage: string | null
  override: boolean
  onRetry: () => void
  onOverride: () => void
}) {
  if (state === "onsite") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-brand-500/40 bg-brand-50 px-3 py-2 text-sm text-brand-700">
        <MapPin className="h-4 w-4" />
        <span>
          You&rsquo;re onsite
          {distanceMeters != null && (
            <> ({Math.round(distanceMeters)}m from the recorded point).</>
          )}
        </span>
      </div>
    )
  }
  if (state === "requesting" || state === "idle") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking your location&hellip;
      </div>
    )
  }
  if (override) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-muted">
        <MapPinOff className="h-4 w-4" />
        Showing prompts without a location check.
      </div>
    )
  }
  if (state === "offsite") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <MapPinOff className="h-4 w-4 text-muted" />
          <span>
            You&rsquo;re {distanceMeters != null ? Math.round(distanceMeters) : "?"}m
            from the jobsite. Prompts unlock within 200m.
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
          <Button size="sm" variant="secondary" onClick={onOverride}>
            Show anyway
          </Button>
        </div>
      </div>
    )
  }
  // denied / unavailable
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <MapPinOff className="h-4 w-4 text-muted" />
        <span>{errorMessage ?? "Couldn't determine your location."}</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="secondary" onClick={onOverride}>
          Show anyway
        </Button>
      </div>
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
    prompt.trigger === "past_due" || prompt.trigger === "ending_today"
  const isStartPrompt =
    prompt.trigger === "starting_today" ||
    prompt.trigger === "upcoming_unstarted"

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
                ? "What date did it actually complete?"
                : picking === "new_end_date"
                  ? "What's the new end date?"
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
              Yes, completing today
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setDateValue(prompt.end_date ?? todayISO())
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
              No, new end date&hellip;
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

function CoordinatesSetup({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [lat, setLat] = useState("")
  const [lng, setLng] = useState("")
  const [done, setDone] = useState(false)

  function save() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await setProjectCoordinates({
          project_id: projectId,
          latitude: lat,
          longitude: lng,
        } as Parameters<typeof setProjectCoordinates>[0])
        if (!res.ok) setError(res.error)
        else setDone(true)
      } catch {
        setError("Couldn't save coordinates. Please try again.")
      }
    })
  }

  if (done) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-8 w-8" />}
        title="Coordinates saved"
        description="Reload the page to start the location check."
        action={
          <Button onClick={() => window.location.reload()}>Reload</Button>
        }
      />
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Set the jobsite coordinates to enable onsite check-ins
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-muted">
          Open the address in Google Maps, right-click the spot, then copy
          the latitude/longitude pair from the menu and paste them below.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Latitude">
            <Input
              type="number"
              step="any"
              min={-90}
              max={90}
              placeholder="40.123456"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </Field>
          <Field label="Longitude">
            <Input
              type="number"
              step="any"
              min={-180}
              max={180}
              placeholder="-111.987654"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
            />
          </Field>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div>
          <Button onClick={save} disabled={pending || !lat || !lng}>
            {pending ? "Saving…" : "Save coordinates"}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
