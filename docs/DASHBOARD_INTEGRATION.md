# Hines Homes Dashboard sync

Two halves to the integration:

1. **Outbound webhooks (PM → dashboard).** PM pushes project + progress
   events to the dashboard via signed POSTs whenever something interesting
   happens (project created, decision approved, daily log published, payment
   recorded).
2. **Inbound API reads (PM → dashboard).** Projects start their life on the
   dashboard (with the client's contact info captured during sales). When
   staff begins the build, the New Project page lists the dashboard's
   not-yet-attached projects so staff can pick one and PM mirrors the
   identity fields locally.

The dashboard is a separate Supabase project; it mirrors what it needs
locally rather than reading the PM app's database directly, and PM mirrors
the dashboard's project identity locally rather than joining across DBs.

## Configuration

Five env vars on the PM app's Vercel deployment (Settings → Environment
Variables) — the fifth (`DASHBOARD_PROTECTION_BYPASS`) is only needed when the
dashboard's Vercel deploy has Deployment Protection turned on:

| Var | Example | Purpose |
|---|---|---|
| `DASHBOARD_BASE_URL` | `https://hines-homes-dashboard.vercel.app` | Used to auto-derive `dashboard_url` on new projects (`{base}/projects/{project_number}`) AND as the base for inbound API reads. |
| `DASHBOARD_WEBHOOK_URL` | `https://hines-homes-dashboard.vercel.app/api/sync` | Endpoint that receives outbound event POSTs. |
| `DASHBOARD_WEBHOOK_SECRET` | random 32+ char string | Shared secret for HMAC-SHA256 signing of outbound webhooks. |
| `DASHBOARD_API_SECRET` | random 32+ char string | Bearer token PM sends on inbound GETs. Independent of the webhook secret so each can be rotated separately. |
| `DASHBOARD_PROTECTION_BYPASS` (optional) | string from Vercel | Set only if the dashboard's Vercel deploy has **Deployment Protection** turned on. Without it, every outbound call from PM hits Vercel's 403 wall before reaching the function. With it set, PM adds `x-vercel-protection-bypass: <token>` to every webhook + API call. Get this value from Vercel → dashboard project → Settings → Deployment Protection → Protection Bypass for Automation. |

If `DASHBOARD_BASE_URL` / `DASHBOARD_WEBHOOK_URL` / `DASHBOARD_WEBHOOK_SECRET`
are unset, **outbound webhooks** are a no-op. If `DASHBOARD_API_SECRET` is
unset (or the base URL is unset), the **inbound picker** silently shows
nothing and staff fall back to the "Create blank" path. Both halves are
independently safe for local dev and preview deploys.

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

---

# Inbound API (PM → dashboard)

PM calls the dashboard's REST API when staff opens the New Project page so
the "Pull from dashboard" picker can render a list of projects that exist
on the dashboard but haven't been adopted by PM yet.

## Endpoints the dashboard MUST expose

Both endpoints authenticate via `Authorization: Bearer <DASHBOARD_API_SECRET>`.
They should reject missing / wrong tokens with `401`. Both return JSON.

### `GET /api/projects/available`

Returns dashboard projects with `pm_attached_at IS NULL`. Used to populate
the picker.

```json
[
  {
    "project_number": "2026-001",
    "name": "Smith Residence",
    "address": "123 Main St, Springfield",
    "contract_price": 850000,
    "client_name": "Jane Smith",
    "client_email": "jane@example.com",
    "client_phone": "(555) 123-4567",
    "target_completion_date": "2027-03-15"
  }
]
```

- `project_number` and `name` are required; everything else is nullable.
- Order doesn't matter — PM renders them as-is.
- Return `[]` (not 204) when there are no available projects.
- Cap response size at 200 projects (PM doesn't paginate yet); send
  `5xx` if you'd exceed that and we'll add pagination.

### `GET /api/projects/:project_number`

Returns full project + client info for one project. Used when re-pulling
data for a project that already exists in PM (future feature). Same shape
as one element of the `/available` array.

- Return `404` if not found.
- Return `403` (or `404` — your call) if the project exists but is locked
  to a different PM tenant. We're single-tenant for now so this never fires.

## What the dashboard does when PM adopts a project

When PM sends the `project.created` webhook for a project that already
exists on the dashboard (matched by `project_number`), the dashboard should
set `pm_attached_at = now()` on its row. That removes it from the
`/available` list and signals "the build phase has started." PM's
`projects.id` (sent in the webhook payload) can be stored alongside if the
dashboard wants to deep-link back later.

## Failure modes PM tolerates

- **Dashboard down.** Both list and get return `null` / `[]`. The New
  Project page falls back to the "Create blank" path. No retries.
- **Bad credentials.** Same as above — the picker just shows nothing.
  Check `[dashboard list]` warnings in Vercel logs if staff reports an
  empty picker when they expect projects.
- **Schema drift.** PM normalizes the response and skips rows missing
  `project_number` or `name`. Adding fields is safe; renaming / dropping
  the two required ones will silently drop the project from the picker.

## Adding new pull-down fields

1. Add the field to the `DashboardProject` interface in `lib/dashboard.ts`.
2. Add it to `normalizeDashboardProject` so the field survives parsing.
3. Add a column on `projects` (migration) if PM needs to persist it.
4. Update `createProject` in `app/actions/projects.ts` to read the form
   field and write the column.
5. Update the picker form (`new-project-form.tsx`) to render & submit it.
6. Update this doc.
