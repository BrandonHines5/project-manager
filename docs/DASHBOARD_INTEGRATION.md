# Hines Homes Dashboard sync

The PM app (this repo) pushes project + progress events to the public
Hines Homes Dashboard via signed webhooks. The dashboard is a separate
Supabase project; it mirrors what it needs locally rather than reading
the PM app's database directly.

## Configuration

Three env vars on this app's deployment (Vercel → Settings → Environment
Variables):

| Var | Example | Purpose |
|---|---|---|
| `DASHBOARD_BASE_URL` | `https://dashboard.hineshomes.com` | Used to auto-derive `dashboard_url` on new projects (`{base}/projects/{project_number}`). |
| `DASHBOARD_WEBHOOK_URL` | `https://dashboard.hineshomes.com/api/sync` | Endpoint that receives every event POST. |
| `DASHBOARD_WEBHOOK_SECRET` | random 32+ char string | Shared secret for HMAC-SHA256 signing. |

If any of the three is unset, the whole integration is a no-op — safe for
local dev and preview deploys.

## Events

All requests are `POST` with `Content-Type: application/json`. The body is
a JSON envelope:

```json
{
  "event": "project.created",
  "occurred_at": "2026-05-25T16:00:00.000Z",
  "source": "hh-project-manager",
  "data": { ... }
}
```

`data` is the affected row (selected with `*` from the relevant Supabase
table — see types in `lib/db/types.ts`).

| Event | Fires when | `data` shape |
|---|---|---|
| `project.created` | New project inserted via `createProject` | `Tables<"projects">` |
| `decision.approved` | A decision transitions to `status='approved'` (only on the transition — re-saves of an already-approved decision do NOT re-fire) | `Tables<"decisions">` |
| `daily_log.published` | A daily log is saved with `visibility='client'` (fires on every save of a client-visible log, including edits) | `Tables<"daily_logs">` |
| `payment.recorded` | A new payment is inserted via `savePayment` (edits do not re-fire — payments are append-only on the dashboard side) | `Tables<"project_payments">` |

## Request headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-HH-Event` | The event name, e.g. `decision.approved` |
| `X-HH-Signature` | HMAC-SHA256 hex of the raw request body, keyed with `DASHBOARD_WEBHOOK_SECRET` |

## Verifying on the dashboard side

The PM app exports a `verifyDashboardSignature(body, signature, secret)`
helper in `lib/dashboard.ts` (constant-time comparison) that the dashboard
can copy verbatim. Equivalent inline:

```ts
import { createHmac, timingSafeEqual } from "crypto"

function verify(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  if (expected.length !== signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
```

The dashboard MUST read the raw body BEFORE JSON-parsing it, since any
re-serialization will change whitespace and break the HMAC.

In Next.js App Router that means:

```ts
export async function POST(req: Request) {
  const raw = await req.text()
  const signature = req.headers.get("x-hh-signature") ?? ""
  if (!verify(raw, signature, process.env.DASHBOARD_WEBHOOK_SECRET!)) {
    return new Response("bad signature", { status: 401 })
  }
  const envelope = JSON.parse(raw)
  // ... handle envelope.event + envelope.data
  return new Response(null, { status: 204 })
}
```

## Delivery semantics

- **Best-effort.** A webhook failure is logged and swallowed; the PM app
  never blocks a user-facing save on dashboard availability.
- **At-most-once.** If the dashboard is down during a save, the event is
  lost — there are no retries in v1. Backfill is the dashboard's
  responsibility (it can poll PM via shared Supabase read RLS, or the PM
  app can grow a re-fire endpoint later).
- **5-second timeout.** The dashboard webhook handler should return
  within 5 seconds; longer responses are aborted on the PM side.
- **No retries** in v1. Add SQS / Inngest / a transactional outbox if
  at-least-once delivery becomes important.

## Adding a new event

1. Add the literal to the `DashboardEvent` union in `lib/dashboard.ts`.
2. Call `sendDashboardWebhook("your.event", row)` at the right point in
   the action that owns the change.
3. Update this doc.
4. Make sure the dashboard handler knows what to do with the new event
   name (default is "log and ignore unknown events").
