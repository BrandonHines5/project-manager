import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * Context a send call site attaches so the message lands in the right
 * project's Communications feed. Everything is optional except `kind` —
 * unattributed sends still get logged and show up in the global staff hub.
 */
export type CommLogContext = {
  project_id?: string | null
  company_id?: string | null
  /** Counterparty profile (client/trade) — powers their RLS read. */
  profile_id?: string | null
  /** Staff profile who initiated the send. */
  sent_by?: string | null
  /** Send kind, e.g. 'bid_invite', 'po_release', 'manual_sms'. */
  kind: string
  counterparty_name?: string | null
}

export type CommLogRow = {
  channel: "email" | "sms" | "call"
  direction: "outbound" | "inbound"
  status?: "logged" | "needs_review" | "ignored"
  project_id?: string | null
  company_id?: string | null
  profile_id?: string | null
  sent_by?: string | null
  from_address?: string | null
  to_address?: string | null
  counterparty_name?: string | null
  subject?: string | null
  body?: string | null
  /**
   * Provider-id namespace: 'quo' for SMS/calls (OpenPhone ids — used by both
   * send-time logging and the webhook so the unique (source, provider_id)
   * index dedups the two), 'app' for app-sent email (Resend outbound ids),
   * 'resend_inbound' for inbound email, 'outlook' for Graph messages.
   */
  source: "app" | "quo" | "resend_inbound" | "outlook"
  source_kind?: string | null
  provider_id?: string | null
  call_duration_seconds?: number | null
  call_recording_url?: string | null
  meta?: Record<string, unknown>
  occurred_at?: string
}

/**
 * Best-effort insert into the communications log via the admin client
 * (webhook/cron/token call sites have no staff session). Never throws —
 * a logging hiccup must never break a send.
 */
export async function logCommunication(row: CommLogRow): Promise<void> {
  try {
    const admin = createSupabaseAdminClient()
    if (!admin) return
    const { error } = await admin.from("communications").insert({
      channel: row.channel,
      direction: row.direction,
      status: row.status ?? "logged",
      project_id: row.project_id ?? null,
      company_id: row.company_id ?? null,
      profile_id: row.profile_id ?? null,
      sent_by: row.sent_by ?? null,
      from_address: row.from_address ?? null,
      to_address: row.to_address ?? null,
      counterparty_name: row.counterparty_name ?? null,
      subject: row.subject ?? null,
      body: row.body ?? null,
      source: row.source,
      source_kind: row.source_kind ?? null,
      provider_id: row.provider_id ?? null,
      call_duration_seconds: row.call_duration_seconds ?? null,
      call_recording_url: row.call_recording_url ?? null,
      meta: (row.meta ?? {}) as never,
      ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
    })
    if (error) console.warn("[comms] log insert failed:", error.message)
  } catch (e) {
    console.warn(
      "[comms] log insert exception:",
      e instanceof Error ? e.message : String(e)
    )
  }
}
