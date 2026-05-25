"use client"

import { useActionState } from "react"
import Link from "next/link"
import { createProject, type ProjectFormState } from "@/app/actions/projects"
import { Card, CardBody, CardFooter } from "@/components/ui/card"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function NewProjectForm() {
  const [state, formAction, pending] = useActionState<
    ProjectFormState | undefined,
    FormData
  >(createProject, undefined)

  const err = state?.fieldErrors ?? {}

  return (
    <form action={formAction}>
      <Card>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Project #" hint={err.project_number}>
            <Input
              name="project_number"
              required
              placeholder="2026-001"
              className={err.project_number ? "border-danger" : ""}
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
              className={err.name ? "border-danger" : ""}
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input name="address" placeholder="123 Main St, Springfield" />
          </Field>
          <Field label="Contract price">
            <Input
              name="contract_price"
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
            />
          </Field>
          <Field label="Start date">
            <Input name="start_date" type="date" />
          </Field>
          <Field label="Target completion">
            <Input name="target_completion_date" type="date" />
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
          <Link href="/projects">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create project"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
