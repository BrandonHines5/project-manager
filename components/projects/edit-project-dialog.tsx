"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { updateProject } from "@/app/actions/projects"
import { cn } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

type EditableProject = {
  id: string
  name: string
  address: string | null
  status: Enums<"project_status">
  project_type: Enums<"project_type"> | null
  contract_price: number | null
  start_date: string | null
  target_completion_date: string | null
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  client_name_2: string | null
  client_email_2: string | null
  client_phone_2: string | null
  cost_plus: boolean
  is_template: boolean
  notes: string | null
}

export function EditProjectButton({ project }: { project: EditableProject }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground cursor-pointer"
        title="Edit project"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit
      </button>
      {open && (
        <EditProjectDialog
          project={project}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function EditProjectDialog({
  project,
  onClose,
}: {
  project: EditableProject
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    const form = e.currentTarget
    const fd = new FormData(form)
    const payload = {
      project_id: project.id,
      name: String(fd.get("name") ?? ""),
      address: String(fd.get("address") ?? ""),
      status: String(fd.get("status") ?? project.status),
      project_type: String(fd.get("project_type") ?? ""),
      contract_price: String(fd.get("contract_price") ?? ""),
      start_date: String(fd.get("start_date") ?? ""),
      target_completion_date: String(fd.get("target_completion_date") ?? ""),
      client_name: String(fd.get("client_name") ?? ""),
      client_email: String(fd.get("client_email") ?? ""),
      client_phone: String(fd.get("client_phone") ?? ""),
      client_name_2: String(fd.get("client_name_2") ?? ""),
      client_email_2: String(fd.get("client_email_2") ?? ""),
      client_phone_2: String(fd.get("client_phone_2") ?? ""),
      cost_plus: fd.get("cost_plus") === "on",
      is_template: fd.get("is_template") === "on",
      notes: String(fd.get("notes") ?? ""),
    } as Parameters<typeof updateProject>[0]

    startTransition(async () => {
      try {
        const res = await updateProject(payload)
        if (!res.ok) {
          setError(res.error)
          if (res.fieldErrors) setFieldErrors(res.fieldErrors)
          return
        }
        router.refresh()
        onClose()
      } catch {
        setError("Couldn't save changes. Please try again.")
      }
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        // Don't let backdrop/Escape close while the save is in flight —
        // the user would miss field errors that come back from the action.
        if (!v && !pending) onClose()
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <div>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Update job details and client contact info.
            </DialogDescription>
          </div>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-1 flex-col overflow-hidden">
          <DialogBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2" hint={fieldErrors.name}>
              <Input
                name="name"
                required
                defaultValue={project.name}
                className={cn(fieldErrors.name && "border-danger")}
              />
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue={project.status}>
                <option value="lead">Lead</option>
                <option value="pre_construction">Pre-construction</option>
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="complete">Complete</option>
                <option value="warranty">Warranty</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </Field>
            <Field
              label="Project type"
              hint="Residential shows Hines Homes branding to the client; commercial shows MJV Building Group."
            >
              <Select name="project_type" defaultValue={project.project_type ?? ""}>
                <option value="">— Not set (Hines Homes)</option>
                <option value="residential_new">
                  Residential — New construction
                </option>
                <option value="residential_remodel">
                  Residential — Remodel / Addition
                </option>
                <option value="commercial_new">
                  Commercial — New construction
                </option>
                <option value="commercial_remodel">
                  Commercial — Remodel / Addition
                </option>
              </Select>
            </Field>
            <Field
              label="Contract price"
              hint={fieldErrors.contract_price}
            >
              <Input
                name="contract_price"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                defaultValue={project.contract_price ?? ""}
                className={cn(fieldErrors.contract_price && "border-danger")}
              />
            </Field>
            <Field label="Billing" className="sm:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="cost_plus"
                  defaultChecked={project.cost_plus}
                  className="mt-0.5 h-4 w-4 rounded border-border-strong"
                />
                <span>
                  <span className="font-medium">Cost-plus job</span>
                  <span className="block text-xs text-muted">
                    Track labor hours on daily logs and roll them up per job.
                  </span>
                </span>
              </label>
            </Field>
            <Field label="Template" className="sm:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="is_template"
                  defaultChecked={project.is_template}
                  className="mt-0.5 h-4 w-4 rounded border-border-strong"
                />
                <span>
                  <span className="font-medium">Use as template</span>
                  <span className="block text-xs text-muted">
                    Templates are the only projects offered when creating a new
                    job from &ldquo;Start from template.&rdquo; Assign their
                    schedule items to roles, then map roles to people per job.
                  </span>
                </span>
              </label>
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Input
                name="address"
                placeholder="123 Main St, Springfield"
                defaultValue={project.address ?? ""}
              />
            </Field>
            <Field label="Start date">
              <Input
                name="start_date"
                type="date"
                defaultValue={project.start_date ?? ""}
              />
            </Field>
            <Field label="Target completion">
              <Input
                name="target_completion_date"
                type="date"
                defaultValue={project.target_completion_date ?? ""}
              />
            </Field>
            <Field label="Client name">
              <Input
                name="client_name"
                placeholder="Jane Smith"
                defaultValue={project.client_name ?? ""}
              />
            </Field>
            <Field label="Client phone" hint={fieldErrors.client_phone}>
              <Input
                name="client_phone"
                type="tel"
                placeholder="(555) 123-4567"
                defaultValue={project.client_phone ?? ""}
                className={cn(fieldErrors.client_phone && "border-danger")}
              />
            </Field>
            <Field
              label="Client email"
              className="sm:col-span-2"
              hint={fieldErrors.client_email}
            >
              <Input
                name="client_email"
                type="email"
                placeholder="jane@example.com"
                defaultValue={project.client_email ?? ""}
                className={cn(fieldErrors.client_email && "border-danger")}
              />
            </Field>
            <p className="sm:col-span-2 text-xs font-medium uppercase tracking-wide text-muted">
              Second client (optional)
            </p>
            <Field label="Client 2 name">
              <Input
                name="client_name_2"
                placeholder="John Smith"
                defaultValue={project.client_name_2 ?? ""}
              />
            </Field>
            <Field label="Client 2 phone" hint={fieldErrors.client_phone_2}>
              <Input
                name="client_phone_2"
                type="tel"
                placeholder="(555) 123-4567"
                defaultValue={project.client_phone_2 ?? ""}
                className={cn(fieldErrors.client_phone_2 && "border-danger")}
              />
            </Field>
            <Field
              label="Client 2 email"
              className="sm:col-span-2"
              hint={fieldErrors.client_email_2}
            >
              <Input
                name="client_email_2"
                type="email"
                placeholder="john@example.com"
                defaultValue={project.client_email_2 ?? ""}
                className={cn(fieldErrors.client_email_2 && "border-danger")}
              />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea
                name="notes"
                rows={3}
                defaultValue={project.notes ?? ""}
              />
            </Field>
            {error && (
              <p className="sm:col-span-2 text-sm text-danger">{error}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
