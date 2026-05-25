# Hines Homes — Project Manager

In-house construction project management app, intentionally narrower than Buildertrend.

**Modules:**

- Projects (linked to dashboard site by project number)
- Schedule / To-Dos — primary work items with nested to-dos, predecessors, optional delay log, recurring to-dos, assignments
- Daily Logs *(coming soon)*
- Decisions (Change Orders + Selections) *(coming soon)*
- Files *(coming soon)*
- Pricing *(coming soon)*
- Reports *(coming soon)*

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
/login                                 sign in / sign up
/projects                              list + create
/projects/[id]                         redirects to /schedule
/projects/[id]/schedule                Schedule/To-Dos module
/projects/[id]/{daily-logs,decisions,files,pricing}   placeholders
/notifications                         in-app bell view
/auth/signout                          POST to clear session
```
