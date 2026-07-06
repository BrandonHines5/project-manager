import "server-only"

/**
 * Minimal Microsoft Graph client for the Outlook mail sync: app-only
 * (client-credentials) auth + mail delta queries. Scope the app
 * registration to PM mailboxes with an Exchange application access policy —
 * see the env docs in .env.example.
 */

const GRAPH = "https://graph.microsoft.com/v1.0"

export function graphConfigured(): boolean {
  return Boolean(
    process.env.MS_TENANT_ID &&
      process.env.MS_CLIENT_ID &&
      process.env.MS_CLIENT_SECRET
  )
}

export async function getGraphToken(): Promise<string | null> {
  const tenant = process.env.MS_TENANT_ID
  const clientId = process.env.MS_CLIENT_ID
  const clientSecret = process.env.MS_CLIENT_SECRET
  if (!tenant || !clientId || !clientSecret) return null

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (!res.ok) {
    console.error(`[graph] token request failed (${res.status})`)
    return null
  }
  const json = (await res.json()) as { access_token?: string }
  return json.access_token ?? null
}

export type GraphMessage = {
  id: string
  internetMessageId?: string
  subject?: string
  bodyPreview?: string
  receivedDateTime?: string
  sentDateTime?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[]
  /** Present on delta responses for deleted items — we skip those. */
  "@removed"?: { reason?: string }
}

const SELECT =
  "$select=internetMessageId,subject,bodyPreview,receivedDateTime,sentDateTime,from,toRecipients"

/** Initial delta URL for a mailbox folder ('inbox' | 'sentitems'). */
export function initialDeltaUrl(mailbox: string, folder: string): string {
  return `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages/delta?${SELECT}&$top=50`
}

/**
 * Fetch one page of a delta sync. Returns the messages plus whichever link
 * comes back — @odata.nextLink (more pages waiting) or @odata.deltaLink
 * (caught up; save it for the next cron run).
 */
export async function fetchDeltaPage(
  token: string,
  url: string
): Promise<{
  messages: GraphMessage[]
  nextLink: string | null
  deltaLink: string | null
} | null> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    console.error(`[graph] delta page failed (${res.status}): ${text.slice(0, 200)}`)
    return null
  }
  const json = (await res.json()) as {
    value?: GraphMessage[]
    "@odata.nextLink"?: string
    "@odata.deltaLink"?: string
  }
  return {
    messages: json.value ?? [],
    nextLink: json["@odata.nextLink"] ?? null,
    deltaLink: json["@odata.deltaLink"] ?? null,
  }
}

export type GraphSendResult = {
  sent: boolean
  reason?: string
  /** RFC internetMessageId — the dedup key against the Outlook sync. */
  internetMessageId?: string
}

/**
 * Send an email from a user's real mailbox (app-only auth; the Exchange
 * application access policy gates which mailboxes we can act as). Uses
 * draft → send instead of /sendMail so we can capture the draft's
 * internetMessageId first — logging with it means the Outlook sync's later
 * pass over Sent Items upserts onto the same (source, provider_id) row
 * instead of duplicating the message in the feed.
 */
export async function sendGraphMail(opts: {
  fromMailbox: string
  to: string[]
  cc?: string[]
  replyTo?: string[]
  subject: string
  text: string
  html?: string
  /** base64-encoded bytes, same shape sendEmail already accepts. */
  attachments?: { filename: string; content: string }[]
}): Promise<GraphSendResult> {
  const token = await getGraphToken()
  if (!token) return { sent: false, reason: "Graph token unavailable" }

  const asRecipients = (list: string[]) =>
    list.map((address) => ({ emailAddress: { address } }))
  const base = `${GRAPH}/users/${encodeURIComponent(opts.fromMailbox)}`
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }

  const draftRes = await fetch(`${base}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subject: opts.subject,
      body: {
        contentType: opts.html ? "HTML" : "Text",
        content: opts.html ?? opts.text,
      },
      toRecipients: asRecipients(opts.to),
      ...(opts.cc?.length ? { ccRecipients: asRecipients(opts.cc) } : {}),
      ...(opts.replyTo?.length ? { replyTo: asRecipients(opts.replyTo) } : {}),
      ...(opts.attachments?.length
        ? {
            attachments: opts.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentBytes: a.content,
            })),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!draftRes.ok) {
    const text = await draftRes.text().catch(() => "")
    return {
      sent: false,
      reason: `Graph draft failed (${draftRes.status}): ${text.slice(0, 200)}`,
    }
  }
  const draft = (await draftRes.json()) as {
    id?: string
    internetMessageId?: string
  }
  if (!draft.id) return { sent: false, reason: "Graph draft returned no id" }

  const sendRes = await fetch(`${base}/messages/${draft.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!sendRes.ok) {
    const text = await sendRes.text().catch(() => "")
    // Best-effort cleanup so failed sends don't strand drafts in the mailbox.
    await fetch(`${base}/messages/${draft.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
    return {
      sent: false,
      reason: `Graph send failed (${sendRes.status}): ${text.slice(0, 200)}`,
    }
  }
  return { sent: true, internetMessageId: draft.internetMessageId }
}
