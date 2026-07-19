import "server-only"
import Stripe from "stripe"

// Stripe billing (Stage S / S3). Env-gated end to end: the client, the checkout
// action, and the webhook all no-op cleanly until Brandon sets the STRIPE_* keys
// in Vercel. A lapsed sandbox trial subscribes via Checkout; the webhook flips
// the org back to 'active_subscriber'. Everything here is server-only.
//
// Env:
//   STRIPE_SECRET_KEY      — the API key; unset ⇒ billing is off.
//   STRIPE_PRICE_ID        — the recurring subscription price to sell.
//   STRIPE_WEBHOOK_SECRET  — the endpoint signing secret for /api/stripe/webhook.

let cached: Stripe | null | undefined

/**
 * The Stripe client, or null when STRIPE_SECRET_KEY is unset (billing off).
 * apiVersion is intentionally omitted so the SDK uses the version it ships with,
 * which avoids pinning to a literal that drifts out of the type on upgrades.
 */
export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached
  const key = process.env.STRIPE_SECRET_KEY
  cached = key ? new Stripe(key) : null
  return cached
}

/** Whether checkout is fully configured (needs both the key and a price). */
export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID
}

/** The subscription price to sell, or null when unset. */
export function stripePriceId(): string | null {
  return process.env.STRIPE_PRICE_ID ?? null
}

/** The webhook signing secret, or null when unset. */
export function stripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET ?? null
}
