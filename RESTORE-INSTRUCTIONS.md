# RESTORE INSTRUCTIONS — Hines Homes Project Manager

> **You are an AI coding agent reading this from a backup folder.** Your job is to
> rebuild this application from scratch using the files alongside this document.
> Follow the steps in order. **Never invent secrets, URLs, keys, or account
> credentials.** Whenever you need a value you don't have (Supabase login, a new
> project's connection string, an API key, a hosting login, a DNS record), STOP
> and ask the human operator for it. It is always correct to pause and ask rather
> than guess.

---

## What this app is

- **Project Manager** — an in-house construction project-management web app for
  Hines Homes (a narrower, self-hosted alternative to Buildertrend). Modules:
  Projects, Schedule/To-Dos, Daily Logs, Decisions (change orders + selections),
  Files, Pricing/Payments, Companies, Reports, Notifications, plus an AI
  "smart-update" agent.
- **Framework:** Next.js 16 (App Router, Turbopack) + React 19 + TypeScript.
  - Note: `middleware.ts` is renamed to **`proxy.ts`** (default export `proxy`).
- **Styling:** Tailwind CSS v4 with custom design tokens in `app/globals.css`.
- **Backend:** Supabase — Postgres (with **Row-Level Security as the source of
  truth for access control**), Auth, and Storage.
- **Package manager:** npm (a `package-lock.json` is committed).
- **Hosting:** Vercel. A Vercel Cron (`vercel.json`) hits
  `/api/cron/email-digest` daily at 13:00 UTC.
- **There are NO Supabase Edge Functions** in this project. Scheduled work is a
  Next.js API route driven by Vercel Cron, not a Supabase function. (The "deploy
  edge functions" step below is therefore a no-op for this app — see Step 7.)

### Original infrastructure (for reference — do not assume these still exist)

- Original Supabase project name: **HH-ProjectManager**, ref `ckvycpfyydmphtizsppn`,
  region **us-east-2**, Postgres **17**.
- Original GitHub repo: `brandonhines5/project-manager`.
- Original hosting: Vercel project (Next.js framework preset).

When rebuilding you will create a **new** Supabase project and likely a **new**
Vercel project; the values above are only to help you recognize what the old
wiring looked like.

---

## What's in this backup folder

Each nightly run drops these into the SharePoint folder for this project:

| File | What it is |
|------|------------|
| `backup_<timestamp>.sql.gz` | Gzipped `pg_dump` (plain SQL, `--no-owner --no-privileges`) of the **entire** Postgres database — schema **and** data. |
| `code_<timestamp>.zip` | `git archive` of the repository source at HEAD (the full app, including `supabase/migrations/`). |
| `storage/` | A mirror of the Supabase Storage bucket files (the `project-files` bucket — uploaded photos, plans, permits, decision/daily-log attachments). Present only if S3 creds were configured for the backup job. |
| `RESTORE-INSTRUCTIONS.md` | This file. |

Pick the newest matching `<timestamp>` triplet when restoring.

---

## Rebuild steps (in order)

### Step 0 — Gather access first
Ask the operator for, and confirm you have:
- A Supabase account/login and which **organization** the new project should live in.
- A Vercel account/login (or the chosen alternative host).
- Any third-party API keys this app uses (see the env-var table in Step 8). Most
  are optional; the app runs with just the two Supabase public values.

### Step 1 — Unzip the source code
```bash
unzip code_<timestamp>.zip -d project-manager
cd project-manager
```

### Step 2 — Install dependencies
```bash
npm install
```
(Node 20+ recommended; the repo targets Next.js 16 / React 19.)

### Step 3 — Create a new Supabase project
- In the Supabase dashboard, create a new project. **Ask the operator** to do this
  or to provide access; note the new **project ref**, **region**, and the
  **database password** they set.
- Record these values you'll need shortly (ask the operator / read from the new
  project's dashboard — do not invent):
  - New **DB connection URI** — Dashboard → Settings → Database → Connection string (URI).
  - New **Project URL** and **publishable/anon key** — Dashboard → Settings → API.
  - New **service_role key** — Dashboard → Settings → API.
  - New **Storage S3 endpoint, region, access key, secret** — Dashboard → Settings → Storage.

### Step 4 — Restore the database (schema + data)
You have two valid paths. **Prefer A** because the dump captures the exact live
state including RLS policies, triggers, functions, and data.

**A. Restore directly from the dump (recommended):**
```bash
gunzip -c backup_<timestamp>.sql.gz | psql "<NEW_DB_CONNECTION_URI>"
```
The dump was taken with `--no-owner --no-privileges`, so it applies cleanly to a
fresh project under the new owner. If you hit ordering errors on extensions or the
`storage`/`auth` schemas, see "Troubleshooting the restore" below.

**B. Re-run migrations, then load data:**
If you only need the schema fresh (e.g. starting clean), apply the SQL migrations
in `supabase/migrations/` **in numeric order** (`0001_init.sql` … `0047_*.sql`)
via the Supabase CLI (`supabase db push`) or the SQL editor, then load data
separately. Migration `0003_daily_logs.sql` creates the `project-files` Storage
bucket and its RLS policies; later migrations extend them.

After restoring, regenerate TypeScript types if you changed anything:
```bash
supabase gen types typescript --project-id <NEW_REF> > lib/db/types.ts
```

### Step 5 — Recreate Storage buckets and copy files back
This app uses a **single private bucket: `project-files`** (keys look like
`projects/{project_id}/daily-logs/{random}.{ext}`, plus decision/plan attachments).

1. Ensure the bucket exists. The dump (Step 4A) usually recreates the
   `storage.buckets` row; if not, migration `0003_daily_logs.sql` creates it, or
   create a **private** bucket named `project-files` in the dashboard.
2. Copy the backed-up files back into it via rclone, pointing at the **new**
   project's S3 endpoint (ask the operator for the new S3 access key/secret):
   ```bash
   export RCLONE_CONFIG_SUPANEW_TYPE=s3
   export RCLONE_CONFIG_SUPANEW_PROVIDER=Other
   export RCLONE_CONFIG_SUPANEW_ENV_AUTH=false
   export RCLONE_CONFIG_SUPANEW_ACCESS_KEY_ID="<NEW_S3_ACCESS_KEY_ID>"
   export RCLONE_CONFIG_SUPANEW_SECRET_ACCESS_KEY="<NEW_S3_SECRET_ACCESS_KEY>"
   export RCLONE_CONFIG_SUPANEW_ENDPOINT="https://<NEW_REF>.storage.supabase.co/storage/v1/s3"
   export RCLONE_CONFIG_SUPANEW_REGION="<NEW_REGION>"   # e.g. us-east-2

   rclone copy ./storage supanew: --fast-list --transfers 8 --checkers 8
   ```
   The `./storage` folder already contains the `project-files/...` tree, so files
   land back under the same keys the database rows reference.

### Step 6 — Auth configuration
- This app uses Supabase Auth. A `handle_new_user()` trigger creates a `profiles`
  row (default role `staff`) on signup — restored by the dump.
- In the new project: Dashboard → Authentication → URL Configuration, set **Site
  URL** and **Redirect URLs** to the new deployment URL so signup/confirmation
  links work.
- Migration `0041_entra_identity.sql` adds Microsoft Entra identity support. If the
  operator uses Entra/Azure SSO, re-enter the provider client ID/secret under
  Authentication → Providers (ask the operator — do not invent).

### Step 7 — Edge functions / scheduled jobs
- **No Supabase Edge Functions exist** in this repo, so there are no functions to
  deploy and no function secrets to set.
- The only scheduled job is the Vercel Cron in `vercel.json` calling
  `/api/cron/email-digest` at 13:00 UTC. It is re-created automatically when you
  deploy to Vercel (Step 9). No action needed beyond deploying.

### Step 8 — Set environment variables
Set these on the host (Vercel → Settings → Environment Variables) and/or
`.env.local` for local dev. **Required** ones must be present; the rest are
optional integrations the app degrades gracefully without. Get real values from
the operator / the new Supabase project — never fabricate.

**Required**
| Var | Where it comes from |
|-----|---------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | New Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | New Supabase → Settings → API → publishable/anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | New Supabase → Settings → API → service_role key (server-only; needed for team add/delete via auth.admin) |

**Optional**
| Var | Purpose |
|-----|---------|
| `ANTHROPIC_API_KEY` | AI smart-update agent (`lib/ai/agent.ts`, model `claude-sonnet-4-6`). Without it the agent returns a typed error instead of running. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Outbound email assignment/digest notifications. |
| `NEXT_PUBLIC_APP_URL` | Canonical public URL used to build links in emails. |
| `QUO_API_KEY`, `QUO_FROM_NUMBER` | Quo (OpenPhone) SMS for "Send text to sub". |
| `DASHBOARD_BASE_URL`, `DASHBOARD_WEBHOOK_URL`, `DASHBOARD_WEBHOOK_SECRET` | Outbound sync to the Hines Homes Dashboard (HMAC-signed webhooks). No-op if unset. |
| `DASHBOARD_API_SECRET` | Bearer token for inbound "Pull from dashboard" reads. |
| `DASHBOARD_PROTECTION_BYPASS` | Vercel "Protection Bypass for Automation" token, only if the dashboard deployment has Deployment Protection on. |

(See `.env.example` in the unzipped code for the authoritative, commented list.)

### Step 9 — Deploy to the host
- Push the unzipped source to a Git repo and import it into **Vercel** (framework
  preset: Next.js; build `next build`, install `npm install`). Or deploy with the
  Vercel CLI.
- Add the environment variables from Step 8 to the Vercel project, then deploy.
- The `vercel.json` cron is registered automatically on deploy.

### Step 10 — Verify
- Visit the deployed URL; sign up / log in at `/login` (first user becomes `staff`).
- Check a project's **Daily Logs** and **Files** pages: thumbnails should load via
  signed URLs, confirming Storage files restored correctly.
- Open **Decisions**, **Schedule**, **Pricing**, **Reports** to confirm data is present.
- Confirm RLS works: a `client`/`trade` user should see only what their role allows.
- If email/SMS/AI integrations were configured, exercise one of each.

---

## Troubleshooting the restore

- **Extension or schema-ordering errors** from the dump: run the restore once,
  ignore non-fatal "already exists" notices on `auth`/`storage`/extension objects
  (Supabase preloads those). If a critical object failed, apply
  `supabase/migrations/` in order against a fresh project instead (Step 4B), then
  load just the data tables from the dump.
- **`pg_dump`/`psql` version mismatch:** use a client whose major version matches
  the server (Postgres 17). The backup workflow installs `postgresql-client-17`
  from PGDG for exactly this reason.
- **Storage files present in DB but 404 on download:** the `storage/` mirror was
  likely empty (S3 creds weren't set on the backup job) or wasn't copied to the
  new bucket — recheck Step 5 and that the bucket name is exactly `project-files`.

---

*If anything here conflicts with what you observe in the unzipped code (new
migrations, renamed buckets, added env vars), trust the code and the dump, and
ask the operator before deviating.*
