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
  contract_price: number | null
  start_date: string | null
  target_completion_date: string | null
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  notes: string | null
  latitude: number | null
  longitude: number | null
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
      contract_price: String(fd.get("contract_price") ?? ""),
      start_date: String(fd.get("start_date") ?? ""),
      target_completion_date: String(fd.get("target_completion_date") ?? ""),
      client_name: String(fd.get("client_name") ?? ""),
      client_email: String(fd.get("client_email") ?? ""),
      client_phone: String(fd.get("client_phone") ?? ""),
      notes: String(fd.get("notes") ?? ""),
      latitude: String(fd.get("latitude") ?? ""),
      longitude: String(fd.get("longitude") ?? ""),
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
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <div>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Update job details, client contact info, and jobsite coordinates.
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
                <option value="cancelled">Cancelled</option>
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
            <Field
              label="Jobsite latitude"
              hint={
                fieldErrors.latitude ??
                "Open the address in Google Maps, right-click, copy coordinates."
              }
            >
              <Input
                name="latitude"
                type="number"
                step="any"
                min={-90}
                max={90}
                placeholder="40.123456"
                defaultValue={project.latitude ?? ""}
                className={cn(fieldErrors.latitude && "border-danger")}
              />
            </Field>
            <Field label="Jobsite longitude" hint={fieldErrors.longitude}>
              <Input
                name="longitude"
                type="number"
                step="any"
                min={-180}
                max={180}
                placeholder="-111.987654"
                defaultValue={project.longitude ?? ""}
                className={cn(fieldErrors.longitude && "border-danger")}
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
