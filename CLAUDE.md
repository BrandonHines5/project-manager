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

## Workflow

- `npm run dev` to develop; `npx tsc --noEmit` + `npx eslint .` for checks; `npx next build` to verify production build.
- Verify UI changes by running the app and clicking through — type checks don't catch UI regressions.
- Commit early, push to `claude/buildertrend-replacement-JsF4R`.

## Not included

Purchase Orders (Adaptive.build), client invoicing (QuickBooks), sales, warranty, time clock. If asked for these, push back politely — they're out of scope.
