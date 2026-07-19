import { NextResponse } from "next/server"
import type Stripe from "stripe"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"
import { getStripe, stripeWebhookSecret } from "@/lib/stripe"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * Stripe webhook (Stage S / S3). Configured in the Stripe dashboard against
 * this endpoint with the events checkout.session.completed and
 * customer.subscription.created/updated/deleted, verified with
 * STRIPE_WEBHOOK_SECRET.
 *
 * It's the sole path that flips a sandbox org's billing state: a paid/active
 * subscription → 'active_subscriber' (clearing sandbox_expires_at so the paywall
 * lifts); a canceled/unpaid subscription → back to 'sandbox_expired' (re-freeze).
 * Only orgs it can resolve (via the session's org id or a stored Stripe customer)
 * are touched, and every write is an idempotent upsert, so Stripe's at-least-once
 * / out-of-order delivery is harmless. Non-trial orgs (Hines, operator-provisioned)
 * never have a subscription, so this never affects them.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Admin = SupabaseClient<Database>

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"])

export async function POST(req: Request) {
  const stripe = getStripe()
  const secret = stripeWebhookSecret()
  if (!stripe || !secret) {
    return NextResponse.json(
      { ok: false, error: "Billing is not configured." },
      { status: 503 }
    )
  }

  const sig = req.headers.get("stripe-signature")
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: "Missing stripe-signature." },
      { status: 400 }
    )
  }

  const raw = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, secret)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Invalid signature: ${(e as Error).message}` },
      { status: 400 }
    )
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Server is not configured." },
      { status: 500 }
    )
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session
        const orgId = s.client_reference_id || s.metadata?.org_id || null
        const customerId =
          typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null)
        const subId =
          typeof s.subscription === "string"
            ? s.subscription
            : (s.subscription?.id ?? null)
        // Pull the subscription's real status rather than assuming 'active'.
        let status: string | null = null
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId)
          status = sub.status
        }
        await applyBillingState(admin, {
          orgId,
          customerId,
          subscriptionId: subId,
          status: status ?? "active",
        })
        break
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id
        // subscription.deleted arrives with status 'canceled'.
        const status =
          event.type === "customer.subscription.deleted" ? "canceled" : sub.status
        await applyBillingState(admin, {
          orgId: sub.metadata?.org_id || null,
          customerId,
          subscriptionId: sub.id,
          status,
        })
        break
      }
      default:
        break
    }
  } catch (e) {
    // 500 so Stripe retries a transient failure (which we've logged). Signature
    // failures already returned 400 above and are never retried into here.
    console.error("[stripe webhook] handler error:", (e as Error).message)
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

/**
 * Resolve the org (by explicit id, else by stored Stripe customer) and set its
 * lifecycle from the subscription status: an active/trialing/past_due sub makes
 * the org an active_subscriber (paywall lifts); anything else (canceled, unpaid,
 * incomplete_expired) re-freezes it to sandbox_expired. Always records the
 * customer/subscription ids + status. A no-match is a silent no-op.
 */
async function applyBillingState(
  admin: Admin,
  args: {
    orgId: string | null
    customerId: string | null
    subscriptionId: string | null
    status: string
  }
): Promise<void> {
  const { orgId, customerId, subscriptionId, status } = args

  // Resolve which org this belongs to. Prefer the explicit id (checkout /
  // subscription metadata); fall back to the stored customer mapping.
  let resolvedOrgId = orgId
  if (!resolvedOrgId && customerId) {
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle()
    resolvedOrgId = data?.id ?? null
  }
  if (!resolvedOrgId) {
    console.warn(
      "[stripe webhook] no org for customer",
      customerId,
      "sub",
      subscriptionId
    )
    return
  }

  const active = ACTIVE_STATUSES.has(status)
  const patch: Database["public"]["Tables"]["organizations"]["Update"] = {
    stripe_subscription_id: subscriptionId,
    stripe_subscription_status: status,
    status: active ? "active_subscriber" : "sandbox_expired",
  }
  // Clear the trial clock once they're paying so the lazy-expiry flip can't
  // re-freeze them; leave it untouched when re-freezing.
  if (active) patch.sandbox_expires_at = null
  // Backfill the customer mapping if we resolved via metadata before it was set.
  if (customerId) patch.stripe_customer_id = customerId

  const { error } = await admin
    .from("organizations")
    .update(patch)
    .eq("id", resolvedOrgId)
  if (error) {
    // Throw so the POST handler returns 500 and Stripe retries.
    throw new Error(`org update failed: ${error.message}`)
  }
}
