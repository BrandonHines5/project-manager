-- 0118: Stage S (part 3) — Stripe billing link on organizations.
--
-- A lapsed sandbox trial subscribes through Stripe Checkout; the webhook flips
-- the org back to 'active_subscriber'. These columns hold the Stripe linkage:
--   stripe_customer_id          — the org's Stripe Customer (created on first
--                                 checkout, reused after). One per org.
--   stripe_subscription_id      — the active/most-recent subscription.
--   stripe_subscription_status  — Stripe's status verbatim (active, trialing,
--                                 past_due, canceled, …). Stripe owns this
--                                 vocabulary, so no CHECK constraint here; the
--                                 org lifecycle (organizations.status) stays the
--                                 app's own sandbox/subscriber state machine.
--
-- No RLS change: a member can already read their own organizations row (that's
-- how branding + the paywall resolve). All WRITES are service-role only — the
-- Stripe webhook and the checkout action both run on the admin client — so no
-- new policy is needed (existing org policies gate member reads/self-updates,
-- and none of these columns are member-writable).
--
-- Not a bridge-default concern: no org_id column added here.

alter table public.organizations
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text,
  add column if not exists stripe_subscription_status text;

-- One Stripe customer per org, and it also prevents two orgs pointing at the
-- same customer (which would let one org's payment unlock another).
create unique index if not exists organizations_stripe_customer_key
  on public.organizations (stripe_customer_id)
  where stripe_customer_id is not null;
