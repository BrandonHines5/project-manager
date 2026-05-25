"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import {
  dashboardProjectUrl,
  sendDashboardWebhook,
} from "@/lib/dashboard"

const ProjectInput = z.object({
  project_number: z.string().min(1, "Required").max(64),
  name: z.string().min(1, "Required").max(200),
  address: z.string().max(500).optional().or(z.literal("")),
  status: z
    .enum(["lead", "pre_construction", "active", "on_hold", "complete", "cancelled"])
    .default("active"),
  contract_price: z.coerce.number().nonnegative().nullable().optional(),
  start_date: z.string().optional().or(z.literal("")),
  target_completion_date: z.string().optional().or(z.literal("")),
  // Staff CAN paste a custom URL but the default is auto-derived from
  // project_number — see dashboardProjectUrl().
  dashboard_url: z
    .string()
    .trim()
    .optional()
    .or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

export type ProjectFormState = {
  error?: string
  fieldErrors?: Record<string, string>
}

function emptyToNull<T extends string | undefined | null>(v: T) {
  return v === "" || v == null ? null : v
}

export async function createProject(
  _prev: ProjectFormState | undefined,
  formData: FormData
): Promise<ProjectFormState> {
  const profile = await requireStaff()
  const parsed = ProjectInput.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = issue.path[0]?.toString() ?? "_"
      fieldErrors[k] = issue.message
    }
    return { fieldErrors, error: "Please fix the highlighted fields" }
  }
  const input = parsed.data

  // If staff didn't paste a URL, auto-derive from the project number so the
  // dashboard link is canonical and immediately shareable with the client.
  const finalDashboardUrl =
    emptyToNull(input.dashboard_url) ?? dashboardProjectUrl(input.project_number)

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("projects")
    .insert({
      project_number: input.project_number,
      name: input.name,
      address: emptyToNull(input.address),
      status: input.status,
      contract_price: input.contract_price ?? null,
      start_date: emptyToNull(input.start_date) ?? null,
      target_completion_date: emptyToNull(input.target_completion_date) ?? null,
      dashboard_url: finalDashboardUrl,
      notes: emptyToNull(input.notes),
      created_by: profile.id,
    })
    .select("*")
    .single()

  if (error) {
    return {
      error:
        error.code === "23505"
          ? `Project number "${input.project_number}" already exists`
          : error.message,
    }
  }

  // Best-effort: tell the dashboard a new project exists. Webhook failures
  // never block the redirect — the dashboard can backfill from /projects/[id].
  await sendDashboardWebhook("project.created", data)

  revalidatePath("/projects")
  redirect(`/projects/${data.id}/schedule`)
}
