# Capability Matrix — Who Can See & Do What

Access control verified against the **live RLS policies** deployed to the
HH-ProjectManager Supabase project (`pg_policies` + helper-function bodies),
cross-checked against the app-layer gates in `app/` and `lib/`.

> Terminology: the app now labels the internal **staff** role as **Team** in the
> UI. The database enum value stays `staff`; this doc uses "Team (staff)".

## How access is enforced

There are **three user roles** (Postgres enum `user_role`) plus a **login-free
public surface**:

| Column | Role / surface | Who they are |
|---|---|---|
| **Team (staff)** | `role = 'staff'` | Internal Hines Homes staff (builders, PMs, admins). |
| **Client** | `role = 'client'` | Homeowner client(s). A job can have two co-owner clients (`client_email` / `client_email_2`). |
| **Trade (sub)** | `role = 'trade'` | Subcontractors / vendors, tied to a `companies` row via `profiles.company_id`. |
| **Public (token)** | *no login* | Anyone holding an unguessable per-row `token`: `/bid/{token}`, `/po/{token}`, `/insurance-upload/{token}`, and now `/invite/{token}` (client-portal signup). |

**RLS is the source of truth.** Every public table has RLS enabled. The
`requireStaff` / `requireSession` helpers in `lib/auth.ts` are only **UX
redirects** — RLS independently rejects any row the caller can't see. The RLS
helper functions (`is_staff()`, `current_role_name()`, `current_company_id()`,
`is_member_of_project()`, and the `trade_sees_*` family) are all `SECURITY
DEFINER, STABLE`.

**Public tokenized pages carry no RLS policy of their own.** The unguessable
token is the entire credential; every write from those pages runs on the
**service-role admin client** with compare-and-swap status guards. No policy
grants the `anon` key anything. Revoking a link = nulling the `token`.

**Staff SSO hardening:** when Entra/Azure SSO is enabled, a `staff` profile on a
*password* session is force-signed-out (staff must come through Microsoft). A
missing `profiles` row self-heals as a least-privilege **client**.

Legend: **View** = read; **View own** = only rows tied to them/their
company/their project; **Create/Edit/Approve** = write; **None** = RLS denies.

---

## Projects / Portfolio

| Capability | Team (staff) | Client | Trade (sub) | Public (token) |
|---|---|---|---|---|
| List / view projects | View all + Create/Edit/Delete (`projects_staff_all`) | View own — member projects (`projects_member_read`) | View own — assigned projects (`projects_trade_read` → `trade_sees_project`) | None |
| Landing route | Schedule tab | Redirected to Daily Logs | Their assigned items | N/A |
| Create / edit / archive | Yes (`requireStaff`) | None | None | None |
| Project members (add a client) | Manage (`project_members_staff_all`) | View own membership | View own membership | None |
| Client-portal invites | Send invites (`client_invites_staff_all`) | N/A | N/A | Accept via `/invite/{token}` |

## Schedule & To-dos

| Capability | Team (staff) | Client | Trade (sub) | Public (token) |
|---|---|---|---|---|
| View schedule (work + to-dos) | View all + full edit (`schedule_items_staff_all`) | **None** (no client policy) | View own assigned only (`schedule_items_trade_read`) | None |
| Create / move / complete, baseline, predecessors, delays | Yes | None | None | None |
| Assignments | Manage (`schedule_assignments_staff_all`) | View own | View own (self/company/role) | None |
| Item attachments / comments | All | None | View + comment on assigned items | None |

> Clients see **no schedule**. The only date a client sees is a Decision due date.

## Decisions / Change Orders & Selections

| Capability | Team (staff) | Client | Trade (sub) | Public (token) |
|---|---|---|---|---|
| View decisions | View all + CRUD (`decisions_staff_all`) | View own project's, out-of-draft only (`decisions_client_read`) | View only if assigned, out-of-draft (`decisions_trade_read`) | None |
| Create / draft / edit | Yes | None | None | None |
| **Approve / decline** | On behalf (`requireStaff`) | Approve/decline via RPC `client_decide_decision` (client + project member + `pending_client`; blocked if past due date) | None | None |
| Comments | All | Read + insert own (`dc_client_insert`) | None | None |
| Cost items / follow-up templates | Staff-only | None | None | None |

## Daily / Job Logs

| Capability | Team (staff) | Client | Trade (sub) | Public (token) |
|---|---|---|---|---|
| View daily logs | View all + CRUD (`daily_logs_staff_all`) | View only `visibility='client'` **and** project member (`daily_logs_client_read`) | **None** | None |
| Create / edit / visibility / subs-on-site | Yes | None | None | None |
| Attachments (photos) | All | View on client-visible logs | None | None |
| Comments | All | Read + insert own on client-visible logs | None | None |

## Bid Requests

| Capability | Team (staff) | Client | Trade (sub) | Public — `/bid/{token}` |
|---|---|---|---|---|
| View packages & line items | View all + CRUD | **None** | View own, non-draft only (`bp_trade_read`) | Token holder sees that one package |
| Recipients / invitations | Manage | None | View own company's rows only — never competitors' (`br_trade_read`) | The single recipient row |
| Submit / revise a quote | Enter on behalf | None | Via `/my-bids` → token page | Submit / decline via admin client (CAS guards) |
| Award | Yes (`award_bid` RPC) | None | None | None |

## Purchase Orders

| Capability | Team (staff) | Client | Trade (sub) | Public — `/po/{token}` |
|---|---|---|---|---|
| View POs | View all + CRUD (`po_staff_all`) | **None** | View own, non-draft only (`po_trade_read`) | Token holder sees that one PO |
| Create / release / unrelease / void | Yes (edits are draft-only) | None | None | None |
| **Approve / decline** | Approve on behalf (`staffApprovePurchaseOrder`) | None | Via `/my-pos` → token page | Approve (typed signature + disclaimer) or decline via admin client |
| Line items / attachments / comments | All | None | View own, non-draft (+ comment) | View / post via token |
| **Copy to another job** | Yes (fresh draft; tokens/approval reset) | None | None | None |

## Pricing & Committed Costs

| Capability | Team (staff) | Client | Trade (sub) | Public |
|---|---|---|---|---|
| Contract price | View | View (client pricing view) | None | None |
| Approved change-order / selection deltas | View | View own project's (approved only) | None | None |
| Payment ledger (money **in**) | View (`pp_staff_all`) | View own project's (`pp_client_read`) | None | None |
| **Committed costs** (approved-PO $ by cost code — money **out**) | View **only with `profiles.financial_access = true`** (app gate) | **Never** | **Never** | **Never** |

> Clients see contract price, approved change-order deltas, and their own
> payment ledger — never committed costs. Committed costs additionally require
> the per-staffer `financial_access` flag (an app-layer gate, not RLS).

## Companies, Insurance, Communications, Files

| Capability | Team (staff) | Client | Trade (sub) | Public (token) |
|---|---|---|---|---|
| Company directory | View all + Create/Edit | None | View own company row only (`companies_self_read`) | None |
| Subcontractor insurance (COIs, policies) | View + full CRUD (staff-only) | None | **None** in-app | Upload a COI via `/insurance-upload/{token}` |
| Communications hub (`/communications`) | View all + CRUD (`requireStaff`) | None | None | None |
| Project "Communications" tab | View all threads | View own logged threads (`comms_client_read`) | View own company threads (`comms_trade_read`) | None |
| Project files / plans | All | View files on member projects (`pf_client_read`) | View files on assigned items/decisions (`pf_trade_read`) | None |

## Notifications, Team/Roles, Reports, Warranty, Utilities

| Capability | Team (staff) | Client | Trade (sub) | Public |
|---|---|---|---|---|
| Own notifications (bell) | View / mark read | View / mark read | View / mark read | None |
| **Notification settings** | Edit own + manage any team member / client / company (`notif_pref_staff_all`) | Edit own (`notif_pref_self`) | Edit own | None |
| Manage team (`/team`) — invite, role, `financial_access` | Yes | None | None | None |
| Project roles catalog & assignment | Manage | View catalog | View own memberships + catalog | None |
| Reports (index / delays / variance) | View (all `requireStaff`) | None | None | None |
| Warranty, Utilities, Rentals | View + manage (`requireStaff`) | None | None | None |

## AI Smart-Update Agent & Onsite Walkthrough

| Capability | Team (staff) | Client | Trade (sub) | Public |
|---|---|---|---|---|
| Run agent / propose / apply plan | Yes — all entry points `requireStaff` | None | None | None |
| Onsite voice-memo + photo walkthrough | Yes (`requireStaff`) | None | None | None |
| **PO dollar amounts via the agent** | **Never returned** — `list_purchase_orders` omits all `$` columns by design | N/A | N/A | N/A |

## Feedback

| Capability | Team (staff) | Client | Trade (sub) | Public |
|---|---|---|---|---|
| Submit feedback | Yes | Yes | Yes | None |
| Read feedback | Own + all staff | Own only | Own only | None |
| Triage / update / delete | Yes | None | None | None |

---

## Key rules & edge cases

1. **Clients have no schedule access at all** — no client policy exists on
   `schedule_items`. The client landing redirects to Daily Logs.
2. **Trades have no access to Daily Logs or Decision *comments*.** They can see
   a decision itself (choices/attachments) only if assigned and out-of-draft.
3. **Draft = invisible to non-staff.** Decisions are hidden from clients/trades
   until they leave `draft`; bid packages/POs are hidden from trades until
   `status <> 'draft'`.
4. **Either client co-owner's approval binds both.** `client_decide_decision`
   requires only `client` + project member + `pending_client`; whichever
   co-owner acts first flips it for the household (and it's blocked past the due
   date). This is exactly what the client-portal signup disclaimer acknowledges.
5. **Two money boundaries:** clients never see committed costs; within staff, a
   `financial_access = false` staffer sees the Pricing tab but not the committed
   costs section (and the AI agent never launders PO dollars around this).
6. **Insurance is staff-only** in-app; the only non-staff touchpoint is the
   tokenized COI upload.
7. **Trades see only their own company — never competitors'** pricing or
   invitations.
8. **Public tokenized pages bypass RLS entirely** and run on the service-role
   admin client with compare-and-swap guards; no RLS policy grants the anon key
   any bid/PO/insurance/invite row.
9. **Privilege-escalation guards:** self-insert of a profile is capped at
   `role = 'client'`; a trigger blocks any UPDATE that would change
   `role`, `financial_access`, `company_id`, or claim an Entra identity.
10. **Comment authorship is RLS-enforced** — every client/trade comment INSERT
    policy pins the author id to `auth.uid()`.
