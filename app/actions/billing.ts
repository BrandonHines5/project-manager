"use server"

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getActiveOrgId } from "@/lib/org"
import { getStripe, stripeConfigured, stripePriceId } from "@/lib/stripe"
import { appUrl } from "@/lib/email"

// Stripe billing actions (Stage S / S3). Checkout starts a subscription from the
// paywall's "Subscribe now"; the billing-portal action lets an existing
// subscriber manage/cancel from Organization settings. Neither runs the sandbox
// write guard (assertActiveOrgWritable): the caller's org may BE the expired
// trial, and paying is how they escape the paywall — so these must work while
// the org is frozen. The org row read/write goes through the admin client, which
// bypasses the org write policies.

const NOT_CONFIGURED =
  "Billing isn't set up yet — please reach out to your BuildFox contact to activate your subscription."

export type CheckoutResult = { ok: true; url: string } | { ok: false; error: string }

type OrgRow = { id: string; name: string; stripe_customer_id: string | null }
type BillingCtx =
  | { ok: true; orgId: string; org: OrgRow; admin: SupabaseClient<Database> }
  | { ok: false; error: string }

/**
 * Shared gate for the billing actions: resolve the caller's active org, require
 * they're an owner/admin of it, and load the org row (name + Stripe customer id)
 * on the admin client. The admin client is used because a frozen sandbox org
 * would block a session-client write, and both actions need to reach the org row
 * regardless of lifecycle status.
 */
async function resolveOwnerAdminOrg(): Promise<BillingCtx> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()

  let orgId: string
  try {
    orgId = await getActiveOrgId(supabase, me.id)
  } catch {
    return { ok: false, error: "Couldn't resolve your organization." }
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("member_role")
    .eq("org_id", orgId)
    .eq("profile_id", me.id)
    .maybeSingle()
  if (!membership || !["owner", "admin"].includes(membership.member_role)) {
    return { ok: false, error: "Only an owner or admin can manage billing." }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server is not configured." }

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, name, stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle()
  if (orgErr || !org) {
    return { ok: false, error: "Couldn't load your organization." }
  }
  return { ok: true, orgId, org, admin }
}

/**
 * Create (or resume) a Stripe Checkout session for the caller's active org and
 * return its URL for the browser to redirect to. Owner/admin only. Reuses the
 * org's Stripe customer across attempts, and tags the session with the org id
 * (client_reference_id + subscription metadata) so the webhook can resolve the
 * org even before the customer id is stored.
 */
export async function createSubscriptionCheckout(): Promise<CheckoutResult> {
  const ctx = await resolveOwnerAdminOrg()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const { orgId, org, admin } = ctx

  const stripe = getStripe()
  const priceId = stripePriceId()
  if (!stripeConfigured() || !stripe || !priceId) {
    return { ok: false, error: NOT_CONFIGURED }
  }

  try {
    // Reuse the org's Stripe customer, or create one and store it.
    let customerId = org.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org.name,
        metadata: { org_id: orgId },
      })
      customerId = customer.id
      const { error: upErr } = await admin
        .from("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", orgId)
      if (upErr) {
        // Non-fatal — the webhook also resolves the org via session metadata.
        console.error(
          "[billing] failed to store stripe_customer_id:",
          upErr.message
        )
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: orgId,
      subscription_data: { metadata: { org_id: orgId } },
      allow_promotion_codes: true,
      success_url: appUrl("/?subscribed=1"),
      cancel_url: appUrl("/"),
    })
    if (!session.url) {
      return { ok: false, error: "Stripe did not return a checkout URL." }
    }
    return { ok: true, url: session.url }
  } catch (e) {
    console.error("[billing] checkout create failed:", (e as Error).message)
    return { ok: false, error: "Couldn't start checkout. Please try again." }
  }
}

/**
 * Open a Stripe Billing Portal session for the caller's active org so an
 * existing subscriber can update their card, view invoices, or cancel. Owner/
 * admin only. Requires the org to already have a Stripe customer (i.e. they've
 * been through checkout at least once). Returns the hosted portal URL to
 * redirect to; the portal returns the user to Organization settings.
 *
 * NOTE: the Customer Portal must be enabled once in the Stripe dashboard
 * (Settings → Billing → Customer portal) before this succeeds.
 */
export async function createBillingPortalSession(): Promise<CheckoutResult> {
  const ctx = await resolveOwnerAdminOrg()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const { org } = ctx

  const stripe = getStripe()
  if (!stripe) {
    return { ok: false, error: NOT_CONFIGURED }
  }
  if (!org.stripe_customer_id) {
    return {
      ok: false,
      error: "This organization doesn't have a billing account yet.",
    }
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: appUrl("/settings/organization"),
    })
    return { ok: true, url: session.url }
  } catch (e) {
    console.error("[billing] portal session create failed:", (e as Error).message)
    return {
      ok: false,
      error: "Couldn't open the billing portal. Please try again.",
    }
  }
}
