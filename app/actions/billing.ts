"use server"

import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getActiveOrgId } from "@/lib/org"
import { getStripe, stripeConfigured, stripePriceId } from "@/lib/stripe"
import { appUrl } from "@/lib/email"

// Subscription checkout for a lapsed sandbox trial (Stage S / S3). Called from
// the paywall's "Subscribe now" button. Deliberately does NOT run the sandbox
// write guard (assertActiveOrgWritable): the caller's org IS the expired trial,
// and paying is exactly how they escape the paywall — so this action must work
// while the org is frozen. The org row write (storing the Stripe customer id)
// goes through the admin client, which bypasses the org write policies.

const NOT_CONFIGURED =
  "Billing isn't set up yet — please reach out to your BuildFox contact to activate your subscription."

export type CheckoutResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Create (or resume) a Stripe Checkout session for the caller's active org and
 * return its URL for the browser to redirect to. Owner/admin only. Reuses the
 * org's Stripe customer across attempts, and tags the session with the org id
 * (client_reference_id + subscription metadata) so the webhook can resolve the
 * org even before the customer id is stored.
 */
export async function createSubscriptionCheckout(): Promise<CheckoutResult> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()

  let orgId: string
  try {
    orgId = await getActiveOrgId(supabase, me.id)
  } catch {
    return { ok: false, error: "Couldn't resolve your organization." }
  }

  // Only an owner/admin of the org may start a subscription.
  const { data: membership } = await supabase
    .from("organization_members")
    .select("member_role")
    .eq("org_id", orgId)
    .eq("profile_id", me.id)
    .maybeSingle()
  if (!membership || !["owner", "admin"].includes(membership.member_role)) {
    return {
      ok: false,
      error: "Only an owner or admin can start a subscription.",
    }
  }

  const stripe = getStripe()
  const priceId = stripePriceId()
  if (!stripeConfigured() || !stripe || !priceId) {
    return { ok: false, error: NOT_CONFIGURED }
  }

  // The org row write (customer id) and read run on the admin client — the
  // caller's org may be frozen (sandbox_expired), which would block a session
  // write, and admin also sidesteps any read nuance.
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
