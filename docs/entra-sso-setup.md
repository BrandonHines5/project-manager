# Microsoft Entra SSO (staff) — PM setup

PM uses **hybrid auth**: Hines Homes **staff** sign in with Microsoft Entra and
get their role from the central directory; **clients (homeowners) and trades**
keep email + password. None of the SSO path is active until the steps below are
done, so this can ship dormant.

This is **Path A** from the Central Identity guide (Supabase Auth + RLS): Entra
is added as an OAuth provider and RLS keeps working on `auth.uid()`.

## What the code already does

- `app/auth/callback/route.ts` — exchanges the OAuth code, resolves the person
  against the directory, **denies unless they're active there**, and mirrors the
  effective PM role (`app_roles['pm'] ?? role`, mapped to `staff`/`trade`/
  `client`) into `profiles.role`.
- `lib/identity.ts` — the directory client (`GET /api/identity/resolve`) + role
  mapping. Fails **closed** when unconfigured.
- Login page shows **"Sign in with Microsoft"** only when
  `NEXT_PUBLIC_ENTRA_SSO_ENABLED=1`.
- Migration `0041` adds `profiles.entra_user_id` and exempts the service role
  from the role-escalation trigger so the post-login sync can set staff roles.

## Steps to turn it on

1. **Entra app registration** (Azure portal → App registrations)
   - Add redirect URI (Path A / Supabase): `https://ckvycpfyydmphtizsppn.supabase.co/auth/v1/callback`
   - Note the Application (client) ID, a client secret, and the Tenant ID.

2. **Supabase → Authentication → Providers → Azure**
   - Enable; set client ID + secret; Azure tenant URL:
     `https://login.microsoftonline.com/<TENANT_ID>/v2.0`.

3. **Vercel env vars** (PM project, Production + Preview)
   - `NEXT_PUBLIC_ENTRA_SSO_ENABLED=1` — shows the Microsoft button.
   - `IDENTITY_BASE_URL` — dashboard origin hosting `/api/identity/resolve`
     (optional; falls back to `DASHBOARD_BASE_URL`).
   - `DASHBOARD_API_SECRET` — already set for the dashboard integration; the
     resolve endpoint validates it.
   - `SUPABASE_SERVICE_ROLE_KEY` — already set; used to sync the role.

4. **Dashboard side (separate repo, prerequisite)**
   - Expose `GET /api/identity/resolve?email=…|entra_user_id=…` (bearer
     `DASHBOARD_API_SECRET`) returning `{ id, name, email, entra_user_id,
     is_active, role, app_roles }`.
   - Each staff member who should use PM must be **active** in `team_members`.
     Optional `app_roles` row with app key `pm` to override their PM role.

## Behaviour notes

- **Deny rules**: not in the directory / `is_active=false` / `app_roles.pm` in
  (`none`/`disabled`/`denied`) → signed out + "not authorized".
- **Role mapping**: any active directory member → PM `staff`, unless
  `app_roles.pm` is `client` or `trade`.
- **Transition**: email/password still works for everyone (including staff)
  during cutover. Staff roles only sync to the directory when they sign in via
  Microsoft.
- **Offboarding**: disable the Microsoft account in Entra **and** set
  `is_active=false` in the directory.
