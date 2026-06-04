# Microsoft Entra SSO (staff) — PM setup

PM uses **hybrid auth**: Hines Homes **staff** sign in with Microsoft Entra and
get their role from the central directory; **clients (homeowners) and trades**
keep email + password. Staff are *required* to use Microsoft — a staff account
that tries the password form is bounced to the Microsoft button.

This is **Path A** from the Central Identity guide (Supabase Auth + RLS): Entra
is added as an OAuth provider and RLS keeps working on `auth.uid()`.

## What the code does

- `app/auth/callback/route.ts` — exchanges the OAuth code, resolves the person
  against the directory, **denies unless they're active there**, and mirrors the
  effective PM role into `profiles.role`. The role comes from `app_roles['pm']`:
  `client`/`trade` map through, deny values (`none`/`disabled`/`denied`) reject,
  and anything else (including a missing `app_roles.pm`) defaults to `staff` —
  it does **not** fall back to the directory's global `role`.
- `lib/identity.ts` — the directory client (`GET {IDENTITY_BASE_URL}/api/identity/resolve`)
  + role mapping. Resolves **by email** (see "Why email, not oid" below). Fails
  **closed** when unconfigured or unreachable.
- Login page shows **"Sign in with Microsoft"** only when
  `NEXT_PUBLIC_ENTRA_SSO_ENABLED=1`; staff who use the password form are signed
  back out and told to use Microsoft.
- Migration `0041` adds `profiles.entra_user_id` and exempts the service role
  from the role-escalation trigger so the post-login sync can set staff roles.

## Steps to turn it on

1. **Entra app registration** (Azure portal → App registrations)
   - Add redirect URI (Path A / Supabase): `https://ckvycpfyydmphtizsppn.supabase.co/auth/v1/callback`
   - Note the Application (client) ID, a client secret, and the Tenant ID.

2. **Supabase → Authentication → Providers → Azure**
   - Enable; set client ID + secret.
   - **Azure Tenant URL** — exactly `https://login.microsoftonline.com/<TENANT_ID>`
     with **no trailing `/v2.0`** and **no leading space**. Supabase appends
     `/oauth2/v2.0/authorize` itself; adding `/v2.0` produces a doubled
     `/v2.0/oauth2/v2.0/authorize` path and a Microsoft 404.

3. **Supabase → Authentication → URL Configuration** ← *easy to miss*
   - **Site URL**: `https://hh-pm.vercel.app` (production). After OAuth, Supabase
     redirects to the Site URL when the requested redirect isn't allow-listed —
     if this points at a stale preview deployment, every login lands there.
   - **Redirect URLs**: add `https://hh-pm.vercel.app/**`.

4. **Vercel env vars** (PM project)
   - `NEXT_PUBLIC_ENTRA_SSO_ENABLED=1` — shows the Microsoft button.
   - `IDENTITY_BASE_URL` — the dashboard **origin only**, e.g.
     `https://hines-homes-dashboard.vercel.app`. **Do NOT include the path** —
     PM appends `/api/identity/resolve` itself. A value ending in
     `/api/identity/resolve` produces a doubled path and the fetch fails.
     (Optional; falls back to `DASHBOARD_BASE_URL`.)
   - `DASHBOARD_API_SECRET` — bearer token the resolve endpoint validates; must
     match the dashboard's value.
   - `SUPABASE_SERVICE_ROLE_KEY` — used to sync the role past the
     role-escalation trigger.
   - Env-var changes only take effect on a **fresh redeploy** — redeploy
     production after editing them.

5. **Dashboard side (separate repo, prerequisite)**
   - Expose `GET /api/identity/resolve?email=…` (bearer `DASHBOARD_API_SECRET`)
     returning `{ id, name, email, entra_user_id, is_active, role, app_roles }`
     with `is_active: true` (boolean) for allowed staff.
   - Each staff member who should use PM must be **active** there. Optional
     `app_roles.pm` to override their PM role.

## Why email, not oid

Supabase's Azure provider exposes a **per-app pairwise subject**
(`identity_data.sub`) as the user's provider id — **not** the Entra directory
`oid` the central directory stores (Supabase returns `oid` as null). So PM and
the directory can't join on the Entra oid; PM resolves **by email**, which is
the reliable shared key. PM still records the directory's real `oid` locally
(`profiles.entra_user_id`) from the resolved record for reference.

## Behaviour notes

- **Deny rules**: not in the directory / `is_active=false` / `app_roles.pm` in
  (`none`/`disabled`/`denied`) → signed out + "not authorized".
- **Role mapping**: any active directory member → PM `staff`, unless
  `app_roles.pm` is `client` or `trade`.
- **Staff password login**: blocked while SSO is enabled — staff must use
  Microsoft so the directory governs their role + active status. Clients and
  trades are unaffected.
- **Offboarding**: disable the Microsoft account in Entra **and** set
  `is_active=false` in the directory.

## Troubleshooting

The OAuth callback redirects to `/login?error=<reason>` on failure:

- `oauth` — the code exchange failed (rare; transient or provider misconfig).
- `sso_unconfigured` — `IDENTITY_BASE_URL`/`DASHBOARD_API_SECRET` not set, or the
  service-role key is missing.
- `not_authorized` — PM reached the directory but the person isn't an active
  match (404 / `is_active` not `true` / a thrown fetch from a bad
  `IDENTITY_BASE_URL`). Check the value has no path and is reachable.

To test the endpoint the way PM does (PowerShell):

```powershell
$secret = "<DASHBOARD_API_SECRET>"
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://hines-homes-dashboard.vercel.app/api/identity/resolve?email=you@hineshomes.com" `
  -Headers @{ Authorization = "Bearer $secret" } | Select-Object -ExpandProperty Content
```

A `200` with `"is_active":true` means PM will accept the login.
