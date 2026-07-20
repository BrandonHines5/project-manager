"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import { getActiveOrgId, isLegacyActiveOrg } from "@/lib/org"
import { sendDashboardWebhook } from "@/lib/dashboard"
import type { TablesUpdate } from "@/lib/db/types"

// Empty-string -> null so a cleared date input clears the column.
const nullableDate = z
  .string()
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null))

// ---------------------------------------------------------------------------
// Per-issue (schedule_items) edits
// ---------------------------------------------------------------------------

// Patches only the warranty columns it's handed, so an inline grid edit never
// disturbs the to-do's assignments / checklist / predecessors. Each field is
// applied only when explicitly present.
const WarrantyItemInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().trim().min(1, "Issue is required").max(500).optional(),
  warranty_date_noted: nullableDate,
  warranty_resolution: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  warranty_who_fixing: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  due_date: nullableDate,
  status: z
    .enum(["not_started", "in_progress", "complete", "delayed"])
    .optional(),
  warranty_no_action: z.boolean().optional(),
})

/**
 * Saves an inline edit from the warranty grid. Applies only the warranty
 * columns it's handed, so editing one cell never disturbs the to-do's
 * assignments / checklist / predecessors. No-ops when nothing changed.
 */
export async function updateWarrantyItem(
  input: z.input<typeof WarrantyItemInput>
) {
  await requireStaff()
  const parsed = WarrantyItemInput.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Invalid warranty item: ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, project_id, ...fields } = parsed.data
  const update: TablesUpdate<"schedule_items"> = {}
  if (fields.title !== undefined) update.title = fields.title
  if (fields.warranty_date_noted !== undefined)
    update.warranty_date_noted = fields.warranty_date_noted
  if (fields.warranty_resolution !== undefined)
    update.warranty_resolution = fields.warranty_resolution
  if (fields.warranty_who_fixing !== undefined)
    update.warranty_who_fixing = fields.warranty_who_fixing
  if (fields.due_date !== undefined) update.due_date = fields.due_date
  if (fields.status !== undefined) update.status = fields.status
  if (fields.warranty_no_action !== undefined)
    update.warranty_no_action = fields.warranty_no_action
  if (Object.keys(update).length === 0) return

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .update(update)
    .eq("id", id)
    .eq("project_id", project_id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

// Adds a new warranty issue row (a to-do) to a home. The grid renders an empty
// editable row immediately after.
const CreateWarrantyItemInput = z.object({
  project_id: z.string().min(1),
  title: z.string().trim().max(500).optional(),
})

/**
 * Adds a blank warranty issue (a to-do) to a home and returns its id, so the
 * grid can render an empty editable row immediately after.
 */
export async function createWarrantyItem(
  input: z.input<typeof CreateWarrantyItemInput>
) {
  const profile = await requireStaff()
  const parsed = CreateWarrantyItemInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("schedule_items")
    .insert({
      project_id: parsed.project_id,
      kind: "todo",
      title: parsed.title?.trim() || "New warranty item",
      status: "not_started",
      created_by: profile.id,
    })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
  return { id: data.id as string }
}

const DeleteWarrantyItemInput = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
})

/** Permanently removes a warranty issue row from a home. */
export async function deleteWarrantyItem(
  input: z.input<typeof DeleteWarrantyItemInput>
) {
  await requireStaff()
  const parsed = DeleteWarrantyItemInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("schedule_items")
    .delete()
    .eq("id", parsed.id)
    .eq("project_id", parsed.project_id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

// ---------------------------------------------------------------------------
// Adopt a project from the CRM for warranty tracking
// ---------------------------------------------------------------------------
//
// Older homes were managed entirely outside this app (in the CRM), but once
// they enter their warranty period the team needs to track the punch list
// here. These two actions let staff pull such a home straight from the CRM
// `projects` table and create a local project (status='warranty') for it.

// One CRM project the user can adopt. Identity comes from the CRM; we only
// surface what the picker needs to render a row.
export type CrmWarrantyProject = {
  crm_id: string
  project_number: string
  address: string
  owner: string | null
  warranty_end_date: string | null
  status: string | null
}

// Raw shape we read from the CRM `projects` table (it's an untyped client, so
// we narrow it ourselves). Mirrors lib/supabase/crm.ts usage in rentals.ts.
type CrmProjectRow = {
  id: string
  project_number: string | null
  street_address: string | null
  city: string | null
  client_name: string | null
  client_name_2: string | null
  project_status: string | null
  warranty_end_date: string | null
}

/** Joins a CRM street address and city into one display line (e.g. "123 Main St, Springfield"), or null when both are blank. */
function crmAddress(street: string | null, city: string | null): string | null {
  return (
    [street, city]
      .map((v) => v?.trim())
      .filter((v): v is string => !!v)
      .join(", ") || null
  )
}

/** Joins the CRM's two owner-name slots into one "A & B" display string, or null when both are blank. */
function crmOwner(name: string | null, name2: string | null): string | null {
  return (
    [name, name2]
      .map((v) => v?.trim())
      .filter((v): v is string => !!v)
      .join(" & ") || null
  )
}

/**
 * Lists CRM homes that have a warranty period (warranty_end_date set) and are
 * NOT already in this app, so staff can adopt them for warranty tracking.
 * Dedupes against local projects on project_number (the shared key). Returns a
 * typed result rather than throwing — Next masks thrown messages in
 * production, and "CRM not configured" needs to reach the user verbatim.
 */
export async function listCrmWarrantyProjects(): Promise<
  { ok: true; projects: CrmWarrantyProject[] } | { ok: false; error: string }
> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  if (!(await isLegacyActiveOrg(supabase, me.id))) {
    return { ok: false, error: "Warranty CRM projects are only available for Hines Homes." }
  }
  const crm = createCrmClient()
  if (!crm) {
    return {
      ok: false,
      error:
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  const { data: crmProjects, error: crmErr } = await crm
    .from("projects")
    .select(
      "id, project_number, street_address, city, client_name, client_name_2, project_status, warranty_end_date"
    )
    .not("warranty_end_date", "is", null)
    .order("warranty_end_date", { ascending: false })
  if (crmErr) return { ok: false, error: crmErr.message }

  // Exclude anything already tracked here. project_number is the shared key
  // between the two systems, so dedupe on it. (supabase is already created
  // above for the legacy-org gate.)
  const { data: existing, error: exErr } = await supabase
    .from("projects")
    .select("project_number")
  if (exErr) return { ok: false, error: exErr.message }
  const taken = new Set((existing ?? []).map((p) => p.project_number))

  const projects = ((crmProjects ?? []) as CrmProjectRow[])
    .filter((p) => p.project_number && !taken.has(p.project_number))
    .map((p) => ({
      crm_id: p.id,
      project_number: p.project_number as string,
      address: crmAddress(p.street_address, p.city) ?? (p.project_number as string),
      owner: crmOwner(p.client_name, p.client_name_2),
      warranty_end_date: p.warranty_end_date,
      status: p.project_status,
    }))
  return { ok: true, projects }
}

// Full read for the adopt step — a few more identity columns than the list.
type CrmProjectFullRow = CrmProjectRow & {
  client_email: string | null
  client_phone: string | null
  client_email_2: string | null
  client_phone_2: string | null
  start_date: string | null
  end_date: string | null
  notes: string | null
}

const AddCrmProjectInput = z.object({ crm_id: z.string().min(1) })

/**
 * Adopts one CRM project as a local warranty project. Copies the home's
 * identity (number, address, owner, warranty end date) and stamps
 * status='warranty' so it shows up on this page. Maps a duplicate
 * project_number to a friendly message and fires a best-effort dashboard
 * webhook to keep the CRM's pm_attached_at in sync, mirroring createProject.
 */
export async function addWarrantyProjectFromCrm(
  input: z.input<typeof AddCrmProjectInput>
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const profile = await requireStaff()
  const parsed = AddCrmProjectInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid project." }

  const supabase = await createSupabaseServerClient()
  if (!(await isLegacyActiveOrg(supabase, profile.id))) {
    return {
      ok: false,
      error: "Warranty CRM projects are only available for Hines Homes.",
    }
  }

  const crm = createCrmClient()
  if (!crm) {
    return {
      ok: false,
      error:
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  const { data: row, error: crmErr } = await crm
    .from("projects")
    .select(
      "id, project_number, street_address, city, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2, project_status, warranty_end_date, start_date, end_date, notes"
    )
    .eq("id", parsed.data.crm_id)
    .maybeSingle()
  if (crmErr) return { ok: false, error: crmErr.message }
  if (!row) return { ok: false, error: "That CRM project could not be found." }
  const p = row as CrmProjectFullRow
  if (!p.project_number) {
    return { ok: false, error: "That CRM project has no project number." }
  }

  // name is NOT NULL locally; the CRM has no name column, so fall back through
  // the most human-friendly identifiers the home actually has.
  const name =
    p.street_address?.trim() || p.client_name?.trim() || p.project_number

  const { data, error } = await supabase
    .from("projects")
    .insert({
      org_id: await getActiveOrgId(supabase, profile.id),
      project_number: p.project_number,
      name,
      address: crmAddress(p.street_address, p.city),
      status: "warranty",
      client_name: p.client_name,
      client_email: p.client_email,
      client_phone: p.client_phone,
      client_name_2: p.client_name_2,
      client_email_2: p.client_email_2,
      client_phone_2: p.client_phone_2,
      warranty_end_date: p.warranty_end_date,
      start_date: p.start_date,
      notes: p.notes,
      created_by: profile.id,
    })
    .select("*")
    .single()
  if (error) {
    return {
      ok: false,
      error:
        error.code === "23505"
          ? `Project "${p.project_number}" is already in this app.`
          : error.message,
    }
  }

  // Best-effort: tell the dashboard a new project exists so it can mark the
  // CRM row pm_attached. Never blocks the adoption.
  await sendDashboardWebhook("project.created", data, data.org_id)

  revalidatePath("/warranty")
  revalidatePath("/projects")
  return { ok: true, id: data.id as string }
}
