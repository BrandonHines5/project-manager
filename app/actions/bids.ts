"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendEmail, appUrl } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { generateAccessToken } from "@/lib/tokens"
import { formatDate } from "@/lib/utils"
import { notifyCommentPosted } from "@/lib/comms/notify"

const optStr = z.string().nullish()

const LineItem = z.object({
  id: optStr,
  cost_code_id: optStr,
  description: z.string().min(1),
  quantity: z.coerce.number().default(1),
  unit: optStr,
})

const Attachment = z.object({
  id: optStr,
  storage_path: z.string(),
  file_name: z.string(),
  file_type: optStr,
  file_size: z.number().nullish(),
  caption: optStr,
})

const BidPackageInput = z.object({
  id: optStr,
  project_id: z.string(),
  title: z.string().min(1).max(300),
  scope: optStr,
  due_date: optStr,
  flat_fee: z.boolean().default(false),
  allow_multiple_awards: z.boolean().default(false),
  line_items: z.array(LineItem).default([]),
  attachments: z.array(Attachment).default([]),
})

export type BidPackageInputT = z.infer<typeof BidPackageInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  return result.data
}

/**
 * Reconcile line items by id rather than wipe-and-reinsert: sub quotes FK
 * these rows, so keeping stable ids preserves quotes for unchanged lines.
 * Deleting a line is an explicit staff choice and cascades its quotes.
 */
async function reconcileLineItems(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  packageId: string,
  items: BidPackageInputT["line_items"]
) {
  const { data: existing, error: exErr } = await supabase
    .from("bid_package_line_items")
    .select("id")
    .eq("bid_package_id", packageId)
  if (exErr) throw new Error(exErr.message)
  const keep = new Set(items.map((i) => nz(i.id)).filter((x): x is string => !!x))
  const toDelete = (existing ?? []).map((e) => e.id).filter((eid) => !keep.has(eid))
  if (toDelete.length) {
    const { error } = await supabase
      .from("bid_package_line_items")
      .delete()
      .in("id", toDelete)
    if (error) throw new Error(error.message)
  }
  for (let i = 0; i < items.length; i++) {
    const li = items[i]
    const liId = nz(li.id)
    const row = {
      cost_code_id: nz(li.cost_code_id),
      description: li.description,
      quantity: li.quantity,
      unit: li.unit ?? null,
      position: i,
    }
    if (liId) {
      const { error } = await supabase
        .from("bid_package_line_items")
        .update(row)
        .eq("id", liId)
        .eq("bid_package_id", packageId)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase
        .from("bid_package_line_items")
        .insert({ ...row, bid_package_id: packageId })
      if (error) throw new Error(error.message)
    }
  }
}

async function reconcileAttachments(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  packageId: string,
  attachments: BidPackageInputT["attachments"]
) {
  const { data: existing, error: existingErr } = await supabase
    .from("bid_package_attachments")
    .select("id, storage_path")
    .eq("bid_package_id", packageId)
  if (existingErr) throw new Error(existingErr.message)
  const keep = new Set(
    attachments.map((a) => nz(a.id)).filter((x): x is string => !!x)
  )
  const toDelete = (existing ?? []).filter((e) => !keep.has(e.id))
  if (toDelete.length) {
    const { error } = await supabase
      .from("bid_package_attachments")
      .delete()
      .in("id", toDelete.map((d) => d.id))
    if (error) throw new Error(error.message)
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
    if (storageErr) {
      console.warn("[saveBidPackage] storage cleanup failed (non-fatal):", storageErr.message)
    }
  }
  const newOnes = attachments.filter((a) => !nz(a.id))
  if (newOnes.length) {
    const startPos = existing?.length ?? 0
    const { error } = await supabase.from("bid_package_attachments").insert(
      newOnes.map((a, i) => ({
        bid_package_id: packageId,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type ?? null,
        file_size: a.file_size ?? null,
        caption: a.caption ?? null,
        position: startPos + i,
      }))
    )
    if (error) throw new Error(error.message)
  }
  for (const a of attachments.filter((a) => nz(a.id))) {
    const { error } = await supabase
      .from("bid_package_attachments")
      .update({ caption: a.caption ?? null })
      .eq("id", a.id!)
      .eq("bid_package_id", packageId)
    if (error) throw new Error(error.message)
  }
}

export async function saveBidPackage(input: BidPackageInputT) {
  const profile = await requireStaff()
  const parsed = parseOrThrow(BidPackageInput, input)
  const supabase = await createSupabaseServerClient()

  let id = nz(parsed.id)
  if (id) {
    const { data: cur, error: curErr } = await supabase
      .from("bid_packages")
      .select("status")
      .eq("id", id)
      .maybeSingle()
    if (curErr) throw new Error(curErr.message)
    if (!cur) throw new Error("Bid package not found")
    const { error } = await supabase
      .from("bid_packages")
      .update({
        title: parsed.title,
        due_date: nz(parsed.due_date),
        // Scope and pricing structure are frozen once released — subs priced
        // against them. reviseBidPackage is the explicit path that changes
        // them and resets responses.
        ...(cur.status === "draft"
          ? {
              scope: parsed.scope ?? null,
              flat_fee: parsed.flat_fee,
              allow_multiple_awards: parsed.allow_multiple_awards,
            }
          : {}),
      })
      .eq("id", id)
    if (error) throw new Error(error.message)
    if (cur.status === "draft") {
      await reconcileLineItems(supabase, id, parsed.flat_fee ? [] : parsed.line_items)
    }
  } else {
    // Race-safe per-project number, same pattern as saveDecision.
    let inserted: { id: string } | null = null
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { data: nextNum, error: rpcErr } = await supabase.rpc(
        "next_bid_package_number",
        { p_project: parsed.project_id }
      )
      if (rpcErr) throw new Error(rpcErr.message)
      const { data, error } = await supabase
        .from("bid_packages")
        .insert({
          project_id: parsed.project_id,
          number: Number(nextNum),
          title: parsed.title,
          scope: parsed.scope ?? null,
          due_date: nz(parsed.due_date),
          flat_fee: parsed.flat_fee,
          allow_multiple_awards: parsed.allow_multiple_awards,
          created_by: profile.id,
        })
        .select("id")
        .single()
      if (!error) {
        inserted = data
        break
      }
      if (error.code !== "23505") throw new Error(error.message)
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
    }
    if (!inserted) {
      throw new Error("Could not allocate a bid number after 5 attempts.")
    }
    id = inserted.id
    await reconcileLineItems(supabase, id, parsed.flat_fee ? [] : parsed.line_items)
  }

  await reconcileAttachments(supabase, id, parsed.attachments)

  revalidatePath(`/projects/${parsed.project_id}/bids`)
  return { id }
}

/**
 * Invite companies to bid (and/or re-send to existing invitees). Flips a
 * draft package to `sent`. Each new recipient gets a fresh access token and
 * an email (+ SMS when a phone is on file) with their public bid link.
 * Send failures are logged, never fatal — the token link can be re-sent.
 */
export async function sendBidPackage({
  id,
  project_id,
  company_ids,
}: {
  id: string
  project_id: string
  company_ids: string[]
}) {
  const profile = await requireStaff()
  if (!company_ids.length) throw new Error("Pick at least one sub/vendor.")
  const supabase = await createSupabaseServerClient()

  const { data: pkg, error: pkgErr } = await supabase
    .from("bid_packages")
    .select("id, title, number, scope, due_date, status, projects:project_id(name)")
    .eq("id", id)
    .maybeSingle()
  if (pkgErr) throw new Error(pkgErr.message)
  if (!pkg) throw new Error("Bid package not found")
  if (pkg.status === "closed") throw new Error("This bid package is closed.")

  const { data: companies, error: coErr } = await supabase
    .from("companies")
    .select("id, name, email, phone, notifications_enabled")
    .in("id", company_ids)
  if (coErr) throw new Error(coErr.message)

  const { data: existingRecipients } = await supabase
    .from("bid_recipients")
    .select("id, company_id, token, status")
    .eq("bid_package_id", id)
  const byCompany = new Map((existingRecipients ?? []).map((r) => [r.company_id, r]))

  const now = new Date().toISOString()
  const sends: { company: NonNullable<typeof companies>[number]; token: string }[] = []

  for (const company of companies ?? []) {
    const existing = byCompany.get(company.id)
    if (existing) {
      // Re-send: only meaningful while they haven't responded.
      if (existing.status !== "invited" || !existing.token) continue
      const { error } = await supabase
        .from("bid_recipients")
        .update({
          last_sent_at: now,
          sent_to_email: company.email,
          sent_to_phone: company.phone,
        })
        .eq("id", existing.id)
      if (error) throw new Error(error.message)
      sends.push({ company, token: existing.token })
    } else {
      const token = generateAccessToken()
      const { error } = await supabase.from("bid_recipients").insert({
        bid_package_id: id,
        company_id: company.id,
        token,
        sent_to_email: company.email,
        sent_to_phone: company.phone,
        last_sent_at: now,
      })
      if (error) throw new Error(error.message)
      sends.push({ company, token })
    }
  }

  // Nothing created or re-sent (stale/invalid company ids, or everyone
  // already responded) — don't flip a draft to sent with no reachable
  // recipients.
  if (!sends.length) {
    throw new Error(
      "No invites were sent — the selected companies may already have responded or no longer exist."
    )
  }

  // draft → sent, once. .eq guard keeps a concurrent send from double-stamping.
  if (pkg.status === "draft") {
    const { error } = await supabase
      .from("bid_packages")
      .update({ status: "sent", sent_at: now })
      .eq("id", id)
      .eq("status", "draft")
    if (error) throw new Error(error.message)
  }

  const projectName =
    (pkg as unknown as { projects: { name: string } | null }).projects?.name ?? "our project"
  const dueLine = pkg.due_date ? ` Bids are due by ${formatDate(pkg.due_date)}.` : ""

  const sendJobs: Promise<unknown>[] = []
  for (const { company, token } of sends) {
    if (!company.notifications_enabled) continue
    const link = appUrl(`/bid/${token}`)
    const log = {
      project_id,
      company_id: company.id,
      sent_by: profile.id,
      kind: "bid_invite",
      counterparty_name: company.name,
    }
    if (company.email) {
      sendJobs.push(
        sendEmail({
          to: [company.email],
          subject: `Bid request: ${pkg.title} — ${projectName}`,
          text: `Hines Homes is requesting a bid for "${pkg.title}" on ${projectName}.${dueLine}\n\nView the scope and submit your bid here (no login needed):\n${link}`,
          log,
        }).catch((e) => console.warn("[sendBidPackage] email failed:", e))
      )
    }
    const e164 = company.phone ? normalizeE164(company.phone) : null
    if (e164) {
      sendJobs.push(
        sendQuoSms({
          to: e164,
          content: `Hines Homes bid request: "${pkg.title}" on ${projectName}.${dueLine} Submit your bid: ${link}`,
          log,
        }).catch((e) => console.warn("[sendBidPackage] SMS failed:", e))
      )
    }
  }
  await Promise.all(sendJobs)

  revalidatePath(`/projects/${project_id}/bids`)
  return { sent: sends.length }
}

/**
 * Revise a released package: update scope/pricing structure, wipe all
 * existing quotes, and reset every non-declined recipient back to `invited`
 * so they re-submit against the new scope. Declined recipients stay
 * declined. Existing token links keep working. Explicit and auditable —
 * clearer than BuilderTrend's silent reset-on-edit.
 */
export async function reviseBidPackage(input: BidPackageInputT) {
  const profile = await requireStaff()
  const parsed = parseOrThrow(BidPackageInput, input)
  const id = nz(parsed.id)
  if (!id) throw new Error("Cannot revise an unsaved bid package.")
  const supabase = await createSupabaseServerClient()

  const { data: pkg, error: pkgErr } = await supabase
    .from("bid_packages")
    .select("status, title, projects:project_id(name)")
    .eq("id", id)
    .maybeSingle()
  if (pkgErr) throw new Error(pkgErr.message)
  if (!pkg) throw new Error("Bid package not found")
  if (pkg.status !== "sent") {
    throw new Error("Only a released (not yet awarded) bid package can be revised.")
  }

  const { error: upErr } = await supabase
    .from("bid_packages")
    .update({
      title: parsed.title,
      scope: parsed.scope ?? null,
      due_date: nz(parsed.due_date),
      flat_fee: parsed.flat_fee,
      allow_multiple_awards: parsed.allow_multiple_awards,
    })
    .eq("id", id)
  if (upErr) throw new Error(upErr.message)

  await reconcileLineItems(supabase, id, parsed.flat_fee ? [] : parsed.line_items)
  await reconcileAttachments(supabase, id, parsed.attachments)

  const { data: recipients, error: recErr } = await supabase
    .from("bid_recipients")
    .select(
      "id, status, token, company_id, companies:company_id(name, email, phone, notifications_enabled)"
    )
    .eq("bid_package_id", id)
  if (recErr) throw new Error(recErr.message)

  const affected = (recipients ?? []).filter((r) => r.status !== "declined")
  if (affected.length) {
    const { error: wipeErr } = await supabase
      .from("bid_line_item_quotes")
      .delete()
      .in("bid_recipient_id", affected.map((r) => r.id))
    if (wipeErr) throw new Error(wipeErr.message)
    const { error: resetErr } = await supabase
      .from("bid_recipients")
      .update({ status: "invited", submitted_at: null, flat_total: null })
      .in("id", affected.map((r) => r.id))
    if (resetErr) throw new Error(resetErr.message)
  }

  const projectName =
    (pkg as unknown as { projects: { name: string } | null }).projects?.name ?? "our project"
  const sendJobs: Promise<unknown>[] = []
  for (const r of affected) {
    const company = (
      r as unknown as {
        companies: {
          name: string
          email: string | null
          phone: string | null
          notifications_enabled: boolean
        } | null
      }
    ).companies
    if (!company?.notifications_enabled || !r.token) continue
    const link = appUrl(`/bid/${r.token}`)
    const log = {
      project_id: parsed.project_id,
      company_id: r.company_id,
      sent_by: profile.id,
      kind: "bid_revised",
      counterparty_name: company.name,
    }
    if (company.email) {
      sendJobs.push(
        sendEmail({
          to: [company.email],
          subject: `Updated bid request: ${parsed.title} — ${projectName}`,
          text: `The bid request "${parsed.title}" on ${projectName} has been updated. Any pricing you already entered was cleared — please review the new scope and re-submit:\n${link}`,
          log,
        }).catch((e) => console.warn("[reviseBidPackage] email failed:", e))
      )
    }
    const e164 = company.phone ? normalizeE164(company.phone) : null
    if (e164) {
      sendJobs.push(
        sendQuoSms({
          to: e164,
          content: `Hines Homes updated the bid request "${parsed.title}" on ${projectName}. Please re-submit: ${link}`,
          log,
        }).catch((e) => console.warn("[reviseBidPackage] SMS failed:", e))
      )
    }
  }
  await Promise.all(sendJobs)

  revalidatePath(`/projects/${parsed.project_id}/bids`)
  return { id, reset: affected.length }
}

/**
 * Award a bid. The SECURITY DEFINER RPC does the atomic part (recipient →
 * awarded, package → awarded, optional draft PO pre-filled from the winning
 * quotes). Emails go out afterward, best-effort.
 */
export async function awardBid({
  recipient_id,
  project_id,
  create_po = true,
  notify_losers = false,
}: {
  recipient_id: string
  project_id: string
  create_po?: boolean
  notify_losers?: boolean
}) {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data, error } = await supabase.rpc("award_bid", {
    p_recipient: recipient_id,
    p_create_po: create_po,
  })
  if (error) throw new Error(error.message)
  const result = (data ?? {}) as { po_id?: string | null; po_number?: number | null }

  // Fetch context for notifications after the atomic flip.
  const { data: winner } = await supabase
    .from("bid_recipients")
    .select(
      "id, bid_package_id, token, company_id, companies:company_id(name, email, notifications_enabled), bid_packages:bid_package_id(title, projects:project_id(name))"
    )
    .eq("id", recipient_id)
    .maybeSingle()

  const pkgInfo = winner as unknown as {
    bid_package_id: string
    token: string | null
    company_id: string
    companies: { name: string; email: string | null; notifications_enabled: boolean } | null
    bid_packages: { title: string; projects: { name: string } | null } | null
  } | null
  const title = pkgInfo?.bid_packages?.title ?? "your bid"
  const projectName = pkgInfo?.bid_packages?.projects?.name ?? "our project"

  const sendJobs: Promise<unknown>[] = []
  if (pkgInfo?.companies?.email && pkgInfo.companies.notifications_enabled) {
    const linkLine = pkgInfo.token
      ? `\n\nView the bid: ${appUrl(`/bid/${pkgInfo.token}`)}`
      : ""
    sendJobs.push(
      sendEmail({
        to: [pkgInfo.companies.email],
        subject: `Bid awarded: ${title} — ${projectName}`,
        text: `Congratulations — your bid for "${title}" on ${projectName} has been accepted.${create_po ? " A purchase order will follow with the full scope and terms." : ""}${linkLine}`,
        log: {
          project_id,
          company_id: pkgInfo.company_id,
          sent_by: profile.id,
          kind: "bid_award",
          counterparty_name: pkgInfo.companies.name,
        },
      }).catch((e) => console.warn("[awardBid] winner email failed:", e))
    )
  }

  if (notify_losers && pkgInfo) {
    const { data: losers } = await supabase
      .from("bid_recipients")
      .select("id, status, company_id, companies:company_id(name, email, notifications_enabled)")
      .eq("bid_package_id", pkgInfo.bid_package_id)
      .neq("id", recipient_id)
    for (const l of losers ?? []) {
      if (l.status !== "submitted") continue
      const co = (
        l as unknown as {
          companies: { name: string; email: string | null; notifications_enabled: boolean } | null
        }
      ).companies
      if (!co?.email || !co.notifications_enabled) continue
      sendJobs.push(
        sendEmail({
          to: [co.email],
          subject: `Bid update: ${title} — ${projectName}`,
          text: `Thank you for bidding on "${title}" at ${projectName}. This scope has been awarded to another contractor. We appreciate your time and look forward to working with you on future projects.`,
          log: {
            project_id,
            company_id: l.company_id,
            sent_by: profile.id,
            kind: "bid_not_awarded",
            counterparty_name: co.name,
          },
        }).catch((e) => console.warn("[awardBid] loser email failed:", e))
      )
    }
  }
  await Promise.all(sendJobs)

  revalidatePath(`/projects/${project_id}/bids`)
  revalidatePath(`/projects/${project_id}/purchase-orders`)
  return { po_id: result.po_id ?? null, po_number: result.po_number ?? null }
}

/** Close bidding without awarding. Revokes all recipient token links. */
export async function closeBidPackage({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error, count } = await supabase
    .from("bid_packages")
    .update(
      { status: "closed", closed_at: new Date().toISOString() },
      { count: "exact" }
    )
    .eq("id", id)
    .eq("status", "sent")
  if (error) throw new Error(error.message)
  // Only revoke tokens after a confirmed sent → closed transition — a
  // no-op close (already awarded/closed) must not kill live links.
  if (!count) throw new Error("Only an open (sent) bid package can be closed.")
  const { error: tokErr } = await supabase
    .from("bid_recipients")
    .update({ token: null })
    .eq("bid_package_id", id)
  if (tokErr) throw new Error(tokErr.message)
  revalidatePath(`/projects/${project_id}/bids`)
}

export async function deleteBidPackage({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: atts } = await supabase
    .from("bid_package_attachments")
    .select("storage_path")
    .eq("bid_package_id", id)
  const paths = (atts ?? []).map((a) => a.storage_path)
  const { error } = await supabase.from("bid_packages").delete().eq("id", id)
  if (error) throw new Error(error.message)
  if (paths.length) {
    await supabase.storage.from("project-files").remove(paths)
  }
  revalidatePath(`/projects/${project_id}/bids`)
}

/** Staff reply on a recipient's comment thread; emails the sub their link. */
export async function postBidCommentStaff({
  bid_recipient_id,
  project_id,
  body,
}: {
  bid_recipient_id: string
  project_id: string
  body: string
}) {
  const profile = await requireStaff()
  if (!body.trim()) throw new Error("Comment is empty")
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("bid_comments").insert({
    bid_recipient_id,
    author_profile_id: profile.id,
    author_name: profile.full_name ?? "Hines Homes",
    body: body.trim(),
  })
  if (error) throw new Error(error.message)

  const { data: rec } = await supabase
    .from("bid_recipients")
    .select(
      "token, company_id, bid_package_id, companies:company_id(name, email, notifications_enabled), bid_packages:bid_package_id(number, title, projects:project_id(name))"
    )
    .eq("id", bid_recipient_id)
    .maybeSingle()
  const info = rec as unknown as {
    token: string | null
    company_id: string
    bid_package_id: string
    companies: {
      name: string
      email: string | null
      notifications_enabled: boolean
    } | null
    bid_packages: {
      number: number
      title: string
      projects: { name: string } | null
    } | null
  } | null
  if (info?.token && info.companies?.email && info.companies.notifications_enabled) {
    await sendEmail({
      to: [info.companies.email],
      subject: `New message on bid: ${info.bid_packages?.title ?? "bid request"}`,
      text: `${profile.full_name ?? "Hines Homes"} wrote:\n\n${body.trim()}\n\nView and reply: ${appUrl(`/bid/${info.token}`)}`,
      log: {
        project_id,
        company_id: info.company_id,
        sent_by: profile.id,
        kind: "bid_comment_notify",
        counterparty_name: info.companies.name,
      },
    }).catch((e) => console.warn("[postBidCommentStaff] email failed:", e))
  }

  // Bell notification for the sub's trade logins (the email above covers
  // subs without portal accounts).
  if (info?.company_id) {
    try {
      const { data: tradeProfiles } = await supabase
        .from("profiles")
        .select("id")
        .eq("company_id", info.company_id)
        .eq("role", "trade")
      await notifyCommentPosted({
        entityLabel: info.bid_packages
          ? `Bid #${info.bid_packages.number} — ${info.bid_packages.title}`
          : "a bid request",
        projectName: info.bid_packages?.projects?.name ?? null,
        authorName: profile.full_name ?? "Hines Homes",
        authorIsStaff: true,
        authorProfileId: profile.id,
        body: body.trim(),
        staffLink: `/projects/${project_id}/bids?open=${info.bid_package_id}&recipient=${bid_recipient_id}`,
        counterpartyProfileIds: (tradeProfiles ?? []).map((p) => p.id),
        counterpartyLink: "/my-bids",
      })
    } catch (e) {
      console.warn("[postBidCommentStaff] notification failed:", e)
    }
  }

  revalidatePath(`/projects/${project_id}/bids`)
  revalidatePath(`/projects/${project_id}/communications`)
}

export async function getSignedUrlsForBids(paths: string[]) {
  await requireStaff()
  if (paths.length === 0) return {}
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage
    .from("project-files")
    .createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}
