@AGENTS.md

# Project Manager — agent notes

## Conventions

- **Next.js 16 App Router** with Turbopack (default). `middleware.ts` is renamed to `proxy.ts` (default export named `proxy`).
- **Async APIs**: `cookies()`, `headers()`, `params`, `searchParams` are all Promises. Always `await` them.
- **Supabase SSR** via `@supabase/ssr`. Server client in `lib/supabase/server.ts`; browser client in `lib/supabase/client.ts`; session refresh in `lib/supabase/proxy.ts` (invoked from `proxy.ts`).
- **Auth helpers**: `getSessionProfile`, `requireSession`, `requireStaff` in `lib/auth.ts`. Use these in server components & actions instead of querying `auth.users` directly.
- **Server actions** live in `app/actions/`. Validate input with `zod`. Use `revalidatePath` after mutations.
- **RLS** is the source of truth for access control. Don't hand-roll role checks in queries — RLS rejects rows the user can't see. The `requireStaff` helper is just a UX redirect.
- **UI primitives** in `components/ui/` (Button, Input, Dialog, Card, Badge, Avatar, EmptyState). Minimal — extend rather than reach for shadcn unless the need is repeated.
- **Design tokens** in `app/globals.css` under `@theme`. Use `bg-brand-500`, `text-foreground`, `border-border`, etc. instead of raw Tailwind colors so the look stays consistent.

## Database

- Migrations: `supabase/migrations/NNNN_name.sql`.
- Apply via Supabase MCP `apply_migration` or `supabase db push`.
- Regenerate types: `supabase gen types typescript --project-id <ref> > lib/db/types.ts`.
- After any DDL, run `get_advisors` (security + performance) and fix WARNs.

## Decisions module — model

- One page for both `change_order` and `selection` kinds — they share table `decisions` with a `kind` enum and a per-project sequential `number`.
- Workflow: `draft` → `pending_client` → `approved` | `rejected`. Clients can only see decisions once they leave `draft`.
- `decision_followup_templates` are per-decision to-do templates the user defines while drafting. On the `approved` transition, `materializeFollowups` in `app/actions/decisions.ts` creates real `schedule_items (kind='todo')` with `source_decision_id` set, plus assignments and in-app notifications for staff assignees. Re-approval is idempotent (it skips templates whose titles already exist as schedule items on this decision).
- `decision_comments`: staff full access; clients in `project_members` for the project can both READ and INSERT (RLS enforces `author_id = auth.uid()`). Trades have no access.
- Decision attachments share the `project-files` Storage bucket with daily logs. The storage RLS policy was extended in 0004 to allow client read for both daily-log AND decision attachments via signed URLs.

## Daily Logs module — model

- `daily_logs(visibility = 'internal'|'client')` — visibility is rendered prominently in the UI (left border + badge). `internal` is hidden from the future client portal; `client` is shown.
- Subs/vendors that were on site live in `daily_log_subs_on_site (daily_log_id, company_id, notes)`.
- Files in `daily_log_attachments` reference Supabase Storage objects in bucket `project-files`, with key `projects/{project_id}/daily-logs/{random}.{ext}`. Bucket is private. Server-side actions issue 1-hour signed URLs via `getSignedUrls` in `app/actions/daily-logs.ts`.
- Browser uploads go directly to Storage with the user's JWT (RLS policy `project_files_staff_all`). The action `saveDailyLog` then records the path in `daily_log_attachments`.
- Clients can `select` from `daily_logs` only when `visibility = 'client'` AND they're in `project_members` for that project — enforced by RLS. Trades have no access to daily logs.

## Schedule/To-Dos module — model

- `schedule_items` is a single table; `kind` is `'work'` or `'todo'`. A to-do nests under a work item via `parent_id`. Standalone to-dos have `parent_id = null`.
- Predecessors live in `schedule_predecessors`. FS is default. Cycle detection lives in `lib/schedule/scheduling.ts:wouldCreateCycle`.
- Cascading dates after a move: `cascadeFromPredecessors` returns successor updates; the server action applies them in a loop.
- Recurring to-dos store a `recurrence_rule` jsonb on a single template row. `lib/schedule/recurrence.ts:expandRecurrence` materialises virtual instances in a date range — we do not pre-create rows.
- Assignments can target either a profile (internal staff) or a company (sub/vendor) — exactly one of the two must be non-null.

## Bid Requests module — model

- `bid_packages` (per-project sequential `number`, statuses `draft → sent → awarded | closed`) with `bid_package_line_items` (cost-coded pricing structure, no unit cost) or `flat_fee` mode. Subs' pricing lives in `bid_line_item_quotes` / `bid_recipients.flat_total`.
- One `bid_recipients` row per invited company, with statuses `invited → submitted | declined → awarded` and an unguessable `token` — the sub's only credential. Public page `/bid/{token}` (no login); mutations in `app/actions/bid-public.ts` run on the **admin client** with compare-and-swap status guards. **No anon RLS policies** — the anon key can never touch bid/PO tables. Revocation = nulling the token (close/unrelease).
- Trade-role subs also see their own company's rows at `/my-bids` (RLS `br_trade_read` / `bp_trade_read`; never competitors' quotes). Cards link to the same token pages — one response UI.
- Staff actions in `app/actions/bids.ts`. "Revise & re-request" (not silent edit) wipes quotes and resets non-declined recipients on a released package. `award_bid` RPC atomically awards + optionally creates a draft PO pre-filled from the winning quotes (`source_bid_recipient_id` links back).
- Send/notify via `sendEmail` + `sendQuoSms`, respecting `companies.notifications_enabled`. Sub submissions notify staff by email + in-app notification (inserted via admin client).

## Purchase Orders module — model

- `purchase_orders` (per-project `number` + optional `custom_number`, statuses `draft → released → approved | declined`, plus `void`; `work_complete` is an independent flag) with `po_line_items` (cost-coded, with unit_cost) or flat fee. v1 has **no payments/bills** — that stays in QuickBooks/Adaptive.
- Release mints a `token` and emails/SMSes the sub a public `/po/{token}` link; the sub approves with a typed signature + disclaimer checkbox (`approved_by_profile_id` null) or declines with a reason. Staff can approve on behalf (`staffApprovePurchaseOrder`, profile id recorded). Unrelease pulls it back to draft, revokes the token, and clears approval state; void keeps the record but kills the link.
- Structural edits are draft-only — released POs must be unreleased first.
- Trade portal page `/my-pos` (RLS `po_trade_read`, own company + non-draft only).
- Approved POs roll up as **Committed costs** by cost code on the project Pricing tab — staff with `profiles.financial_access` only, never clients.
- Numbering RPCs `next_bid_package_number` / `next_po_number` use per-project advisory locks (hash args 1 / 2; decisions use 0). `award_bid` allocates PO numbers under the same lock key as `next_po_number`.

## Subcontractor insurance module — model

- `insurance_documents` (one per ingested COI file) + `insurance_policies` (one per policy parsed off it; enum `insurance_type`: general_liability | workers_comp | auto | umbrella). "Current" policy for a company+type = latest `expiration_date`; older rows are history. Staff-only RLS on both.
- Three ingestion paths, all funneling into `lib/insurance/ingest.ts` (admin client): the Resend inbound webhook `/api/inbound/insurance` (verify with `RESEND_WEBHOOK_SECRET`, download attachments via `resend.emails.receiving.attachments`), the public tokenized sub upload (`/insurance-upload/{companies.insurance_upload_token}` → POST `/api/insurance-upload`), and staff manual upload (browser → Storage, then `processStoredInsuranceDocument`).
- Extraction: `lib/insurance/extract.ts` reads the PDF/image with Claude (`claude-opus-4-8`, structured outputs). Result is stored on `insurance_documents.extraction` so the review queue can assign an unmatched doc to a company without re-running the model. Company auto-match: sender email exact match, then unambiguous name match; anything fuzzy → `status='needs_review'`.
- Reminders: daily cron `/api/cron/insurance-reminders` (auth `CRON_SECRET`) emails each company once per policy when a CURRENT policy expires within 7 days, with their upload link, then stamps `reminder_sent_at`. Respects `companies.notifications_enabled`; the staff "Send request" button does not (explicit click wins). Gated by a global kill switch: the cron no-ops unless `INSURANCE_REMINDERS_ENABLED === "true"` (OFF by default so automatic emails don't go out before the site is live; the manual button is never gated).
- Only companies with `companies.status = 'Approved for Use'` (case-insensitive; helper `lib/insurance/requirements.ts:companyRequiresInsurance`) are REQUIRED to carry insurance — the cron skips everyone else and the dashboard neither lists them by default nor flags their missing coverage ("Show all statuses" reveals them).
- Files live in the `project-files` bucket under `companies/insurance/…` (staff storage RLS already covers it; server paths use the admin client).
- Staff UI: `/companies/insurance` — coverage table (GL/WC required; auto/umbrella tracked), review queue, manual upload, send-request.

## AI smart-update agent — model

- Server action `runAgentTurnAction` in `app/actions/ai-agent.ts` wraps a manual Claude tool-use loop in `lib/ai/agent.ts`. Model is `claude-sonnet-4-6`. Requires `ANTHROPIC_API_KEY` env var (set in Vercel + `.env.local` for dev) — action returns a typed `error` result if the key is missing, never throws.
- Plan-then-approve flow: the agent's `propose_*` tools record mutations into a per-turn array but DON'T execute anything. Only `applyPlanAction` actually writes to the DB, and it runs under the caller's session so RLS still gates writes.
- Adding a new mutation kind takes four changes: extend `ProposedMutation` in `lib/ai/types.ts`, add the `propose_*` tool definition + handler in `lib/ai/agent.ts`, add the apply path in `lib/ai/apply.ts`, and add a case in the plan-row renderer `components/layout/ai-agent.tsx:MutationRow`.
- Field-notes mode: dictated/typed site notes map to schedule updates, to-dos, an SMS to a sub (`send_sms`, sent via `lib/quo.ts` with the recipient re-resolved from `companies.phone` at apply time), and ALWAYS one `append_daily_log` per affected project (appends to, or creates, the internal daily log for that date). The browser sends its local date as `today` so "today" means the user's day, not UTC's. The chat dialog has a Web Speech API mic button for phone dictation.

## Workflow

- `npm run dev` to develop; `npx tsc --noEmit` + `npx eslint .` for checks; `npx next build` to verify production build.
- Verify UI changes by running the app and clicking through — type checks don't catch UI regressions.
- Commit early. Cut feature branches from `main` and open PRs against `main` — that's the active integration branch where all recent work lands. (The old `claude/buildertrend-replacement-JsF4R` branch is stale and far behind `main`; don't target it.)
- **Pull requests**: open as ready-for-review (not draft) so CodeRabbit reviews immediately, and subscribe to PR activity right after opening.

## User environment

- Brandon does **not** have a local development environment — no `git clone`, no Node.js, no `npm`, no local editor running the project. All code edits happen either via the GitHub web UI or through this remote Claude Code session (which commits + pushes from its ephemeral container). All testing happens on Vercel preview / production deploys, not localhost.
- Skip these patterns when giving instructions:
  - "open VS Code" / "edit `.env.local`" / "run `npm run dev`" / "git clone" / "git checkout"
- Use these patterns instead:
  - Code changes: tell Brandon what you're about to change, edit the file from this session, commit + push, and Vercel auto-deploys a preview.
  - Env vars: set in the **Vercel dashboard** (Settings → Environment Variables), then redeploy. Don't reference `.env.local`.
  - Testing: have Brandon visit the Vercel preview URL (for branch deploys) or production URL.
- Brandon runs ad-hoc shell commands (like DNS lookups) in **PowerShell** on Windows. Use PowerShell syntax for those (`Resolve-DnsName` not `dig`, `$env:FOO="bar"` not `export FOO=bar`, `Copy-Item` not `cp`).

## Not included

PO payments/bills & lien waivers (QuickBooks/Adaptive.build), client invoicing (QuickBooks), sales, warranty, time clock. If asked for these, push back politely — they're out of scope. (Purchase Orders and Bid Requests themselves ARE in scope — see the module sections above.)
