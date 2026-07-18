# Hines Homes — Project Manager

In-house construction project management app, intentionally narrower than Buildertrend.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbrandonhines5%2Fproject-manager&project-name=hh-project-manager&repository-name=hh-project-manager&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY&envDescription=Both%20values%20live%20in%20your%20Supabase%20project%20settings%20%E2%86%92%20API)

Or import the existing repo at https://vercel.com/new and pick `brandonhines5/project-manager`.

**Env vars to paste during import:**

```env
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>
```

Find both values in your Supabase project → Settings → API.

After the first deploy: in Supabase Dashboard → Authentication → URL Configuration, add the Vercel URL to **Site URL** + **Redirect URLs** so signup confirmation links work.

Optional later: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL`
(the canonical public URL — production runs at `https://app.buildfox.ai`).


**Modules:**

- **Projects** — linked to dashboard site by project number; status, contract price, target completion, dashboard URL.
- **Schedule / To-Dos** — single page; hierarchical list (primary work items with nested to-dos) + Gantt with predecessor arrows; predecessors with FS/SS/FF/SF + lag and cascading dates; recurring to-dos; assignments to staff or sub/vendor companies; optional delay log.
- **Daily Logs** — internal vs client-visible toggle (prominent); notes; multi-photo/file upload to private Supabase Storage with signed-URL thumbnails; subs-on-site multi-select with per-sub notes.
- **Decisions** (Change Orders + Selections on one page) — per-project sequential number; workflow `draft → pending_client → approved/rejected`; per-decision follow-up to-do templates that auto-create real `schedule_items` on approval (with assignee + due-date offset); comment thread that clients can post to.
- **Files** — first-class plans/permits/contracts uploads + unified gallery of every photo/video across daily logs, decisions, and plans, with search.
- **Pricing** — contract + approved decisions = new total; manual payments table (until QuickBooks sync); balance due.
- **Companies** — subs/vendors/client households with type filter and search; used for schedule assignments and daily-log subs-on-site.
- **Reports** — Delay Report (by reason + by project + filterable date range); Schedule Variance (baseline vs current).
- **Notifications** — in-app bell; populated automatically when decision approval generates follow-up to-dos.

Explicitly NOT included: Purchase Orders (use Adaptive.build), client invoicing (QuickBooks), sales, warranty, time clock.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4 + custom Buildertrend-style design tokens
- Supabase (Postgres, Auth, Storage, RLS)
- Sonner toasts, lucide-react icons, react-hook-form, zod, date-fns, @dnd-kit

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in Supabase URL + publishable key
npm run dev                  # http://localhost:3000
```

First-time setup: sign up at `/login`. The `handle_new_user()` trigger creates a `profiles` row with role `staff` by default.

## Database

Migrations live in `supabase/migrations/`. Apply via Supabase MCP or `supabase db push`.

Generate fresh types after schema changes:

```bash
supabase gen types typescript --project-id <id> > lib/db/types.ts
```

## Roles

- `staff` — full access.
- `trade` — sees only schedule items they (or their company) are assigned to.
- `client` — sees only Daily Logs (visibility=client), Files, Pricing for their project. Never sees Schedule.

Enforced via Postgres RLS — see `supabase/migrations/0001_init.sql`.

## Routes

```
/login                                  sign in / sign up
/projects                               list + create (staff)
/projects/new                           create form (staff)
/projects/[id]                          redirects to /schedule for staff/trade, /daily-logs for clients
/projects/[id]/schedule                 Schedule/To-Dos (staff + trade)
/projects/[id]/daily-logs               Daily Logs
/projects/[id]/decisions                Change Orders + Selections
/projects/[id]/files                    Plans + project gallery
/projects/[id]/pricing                  Contract + decisions + payments
/companies                              Subs / vendors / client households (staff)
/team                                   Everyone with an account; promote/demote roles (staff)
/reports                                Reports landing (staff)
/reports/delays                         Delay Report
/reports/variance                       Schedule Variance
/notifications                          In-app bell
/auth/signout                           POST to clear session
```
