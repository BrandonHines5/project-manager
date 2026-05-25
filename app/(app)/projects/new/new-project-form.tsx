"use client"

import { useActionState, useState } from "react"
import Link from "next/link"
import { Building2, Plus, ChevronRight } from "lucide-react"
import { createProject, type ProjectFormState } from "@/app/actions/projects"
import { Card, CardBody, CardFooter } from "@/components/ui/card"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, cn } from "@/lib/utils"
import type { DashboardProject } from "@/lib/dashboard"

type Mode = "picker" | "form"

export function NewProjectForm({
  available,
}: {
  available: DashboardProject[]
}) {
  // Picker mode is the default ONLY if there are projects to pick. Otherwise
  // skip straight to the blank form — no point showing an empty picker.
  const [mode, setMode] = useState<Mode>(available.length > 0 ? "picker" : "form")
  const [picked, setPicked] = useState<DashboardProject | null>(null)

  function choose(p: DashboardProject) {
    setPicked(p)
    setMode("form")
  }

  function createBlank() {
    setPicked(null)
    setMode("form")
  }

  if (mode === "picker") {
    return (
      <PickerPanel
        available={available}
        onPick={choose}
        onCreateBlank={createBlank}
      />
    )
  }
  return (
    <ProjectFormFields
      picked={picked}
      onBack={available.length > 0 ? () => setMode("picker") : undefined}
    />
  )
}

function PickerPanel({
  available,
  onPick,
  onCreateBlank,
}: {
  available: DashboardProject[]
  onPick: (p: DashboardProject) => void
  onCreateBlank: () => void
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="p-0">
          <div className="px-4 py-2.5 border-b border-border flex items-center gap-2 bg-background/40">
            <Building2 className="h-4 w-4 text-muted" />
            <span className="text-sm font-medium">
              From the dashboard ({available.length})
            </span>
          </div>
          <ul className="divide-y divide-border">
            {available.map((p) => (
              <li key={p.project_number}>
                <button
                  type="button"
                  onClick={() => onPick(p)}
                  className="w-full text-left px-4 py-3 hover:bg-background/40 cursor-pointer flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{p.name}</span>
                      <Badge tone="muted">#{p.project_number}</Badge>
                    </div>
                    <div className="text-xs text-muted mt-0.5 truncate">
                      {p.client_name ? `${p.client_name} · ` : ""}
                      {p.address || "No address"}
                      {p.contract_price != null && (
                        <> · {formatCurrency(p.contract_price)}</>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/projects"
          className="inline-flex items-center text-sm text-muted hover:text-foreground px-3 py-1.5"
        >
          Cancel
        </Link>
        <Button type="button" variant="secondary" onClick={onCreateBlank}>
          <Plus className="h-4 w-4" /> Create blank (not on dashboard)
        </Button>
      </div>
    </div>
  )
}

function ProjectFormFields({
  picked,
  onBack,
}: {
  picked: DashboardProject | null
  onBack?: () => void
}) {
  const [state, formAction, pending] = useActionState<
    ProjectFormState | undefined,
    FormData
  >(createProject, undefined)

  const err = state?.fieldErrors ?? {}
  // When a dashboard project is picked, identity fields are owned by the
  // dashboard — staff can't edit them here. The "Back" button lets them
  // re-pick or switch to blank if they picked the wrong one.
  const locked = picked !== null

  return (
    <form action={formAction}>
      {locked && (
        <input type="hidden" name="dashboard_pulled" value="1" />
      )}
      <Card>
        {locked && (
          <div className="px-4 py-2.5 border-b border-border bg-brand-50 text-sm text-brand-700 flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            <span>
              Pulled from dashboard. Identity fields are read-only here — edit
              them on the dashboard if anything is wrong.
            </span>
          </div>
        )}
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Project #" hint={err.project_number}>
            <Input
              name="project_number"
              required
              placeholder="2026-001"
              defaultValue={picked?.project_number ?? ""}
              readOnly={locked}
              className={cn(
                err.project_number && "border-danger",
                locked && "bg-background/60 text-muted"
              )}
            />
          </Field>
          <Field label="Status">
            <Select name="status" defaultValue="active">
              <option value="lead">Lead</option>
              <option value="pre_construction">Pre-construction</option>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="complete">Complete</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field label="Name" className="sm:col-span-2" hint={err.name}>
            <Input
              name="name"
              required
              placeholder="Smith Residence"
              defaultValue={picked?.name ?? ""}
              readOnly={locked}
              className={cn(
                err.name && "border-danger",
                locked && "bg-background/60 text-muted"
              )}
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input
              name="address"
              placeholder="123 Main St, Springfield"
              defaultValue={picked?.address ?? ""}
              readOnly={locked}
              className={cn(locked && "bg-background/60 text-muted")}
            />
          </Field>
          <Field label="Client name">
            <Input
              name="client_name"
              placeholder="Jane Smith"
              defaultValue={picked?.client_name ?? ""}
              readOnly={locked}
              className={cn(locked && "bg-background/60 text-muted")}
            />
          </Field>
          <Field label="Client phone">
            <Input
              name="client_phone"
              type="tel"
              placeholder="(555) 123-4567"
              defaultValue={picked?.client_phone ?? ""}
              readOnly={locked}
              className={cn(locked && "bg-background/60 text-muted")}
            />
          </Field>
          <Field label="Client email" className="sm:col-span-2">
            <Input
              name="client_email"
              type="email"
              placeholder="jane@example.com"
              defaultValue={picked?.client_email ?? ""}
              readOnly={locked}
              className={cn(locked && "bg-background/60 text-muted")}
            />
          </Field>
          <Field label="Contract price">
            <Input
              name="contract_price"
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              defaultValue={picked?.contract_price ?? ""}
              readOnly={locked}
              className={cn(locked && "bg-background/60 text-muted")}
            />
          </Field>
          <Field label="Start date">
            <Input name="start_date" type="date" />
          </Field>
          <Field label="Target completion">
            <Input
              name="target_completion_date"
              type="date"
              defaultValue={picked?.target_completion_date ?? ""}
            />
          </Field>
          <Field label="Dashboard URL" className="sm:col-span-2">
            <Input
              name="dashboard_url"
              type="url"
              placeholder="https://dashboard.example.com/projects/2026-001"
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea name="notes" rows={3} />
          </Field>
          {state?.error && (
            <p className="sm:col-span-2 text-sm text-danger">{state.error}</p>
          )}
        </CardBody>
        <CardFooter>
          {onBack && (
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
              className="mr-auto"
            >
              ← Back
            </Button>
          )}
          {!onBack && (
            <Link
              href="/projects"
              className="mr-auto inline-flex items-center text-sm text-muted hover:text-foreground px-3 py-1.5"
            >
              Cancel
            </Link>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create project"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
