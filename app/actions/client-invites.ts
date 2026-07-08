"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { generateAccessToken } from "@/lib/tokens"
import { sendEmail, appUrl } from "@/lib/email"

export type InviteClientsResult = {
  sent: number
  alreadyJoined: number
  details: { email: string; status: "sent" | "already_joined" | "failed" }[]
}

/**
 * Invite a job's client contacts (the two projects.client_email slots) to the
 * client portal. Each gets an unguessable tokenized signup link. Re-inviting is
 * safe: an existing un-accepted invite is refreshed with a new token and
 * re-sent; a contact who already accepted is skipped. Runs under the staff
 * session, so RLS (client_invites_staff_all) gates the writes.
 */
export async function inviteProjectClients(
  projectId: string
): Promise<InviteClientsResult> {
  const parsedId = z.string().uuid().safeParse(projectId)
  if (!parsedId.success) throw new Error("Invalid project id")
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select(
      "id, name, project_number, client_name, client_email, client_name_2, client_email_2"
    )
    .eq("id", projectId)
    .maybeSingle()
  if (projErr) throw new Error(projErr.message)
  if (!project) throw new Error("Project not found")

  const contacts = [
    { slot: 1 as const, name: project.client_name, email: project.client_email },
    {
      slot: 2 as const,
      name: project.client_name_2,
      email: project.client_email_2,
    },
  ].filter((c) => c.email && c.email.trim())

  if (!contacts.length) {
    throw new Error(
      "This job has no client email on file. Add a client email to the job first."
    )
  }

  const result: InviteClientsResult = { sent: 0, alreadyJoined: 0, details: [] }

  for (const c of contacts) {
    const email = c.email!.trim().toLowerCase()

    const { data: invites } = await supabase
      .from("client_invites")
      .select("id, accepted_at")
      .eq("project_id", projectId)
      .eq("email", email)
      .order("invited_at", { ascending: false })

    if ((invites ?? []).some((i) => i.accepted_at)) {
      result.alreadyJoined += 1
      result.details.push({ email, status: "already_joined" })
      continue
    }

    const token = generateAccessToken()
    const open = (invites ?? [])[0]
    try {
      if (open) {
        const { error } = await supabase
          .from("client_invites")
          .update({
            token,
            name: c.name,
            invited_by: me.id,
            invited_at: new Date().toISOString(),
          })
          .eq("id", open.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from("client_invites").insert({
          project_id: projectId,
          email,
          name: c.name,
          token,
          contact_slot: c.slot,
          invited_by: me.id,
        })
        if (error) throw new Error(error.message)
      }

      const link = appUrl(`/invite/${token}`)
      const greeting = c.name ? `Hi ${c.name},` : "Hello,"
      await sendEmail({
        to: [email],
        subject: `Your ${project.name} client portal invitation`,
        text: `${greeting}\n\nHines Homes has invited you to the online portal for ${project.name}. There you can review daily updates and approve change orders and selections.\n\nSet up your login here:\n${link}\n\nThis link is just for you — please don't share it.`,
        log: {
          project_id: projectId,
          sent_by: me.id,
          kind: "client_portal_invite",
          counterparty_name: c.name,
        },
      })
      result.sent += 1
      result.details.push({ email, status: "sent" })
    } catch (e) {
      console.warn("[inviteProjectClients] failed for contact slot", c.slot, e)
      result.details.push({ email, status: "failed" })
    }
  }

  revalidatePath(`/projects/${projectId}`)
  return result
}
