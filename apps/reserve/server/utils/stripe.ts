import Stripe from "stripe";

let client: Stripe | null = null;

/**
 * Server-side Stripe client (test or live per the key in env). Read at
 * run time as NUXT_STRIPE_SECRET_KEY (docs/deployment.md, "Secrets at
 * runtime"). Without it, every caller — card-on-file checkout, a refund
 * of a card payment, the late-cancellation fee charge, the webhook —
 * answers 503 naming the variable, not a generic 500; scripts/
 * verify-build-secrets.mjs probes the webhook for exactly that.
 */
export function useStripe(): Stripe {
  if (!client) {
    const key = useRuntimeConfig().stripeSecretKey;
    if (!key) {
      throw createError({
        statusCode: 503,
        statusMessage: "Card payments are not configured on this server (missing NUXT_STRIPE_SECRET_KEY).",
      });
    }
    client = new Stripe(key);
  }
  return client;
}
