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
