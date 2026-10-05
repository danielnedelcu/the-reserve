import Stripe from "stripe";

let client: Stripe | null = null;

/** Server-side Stripe client (test or live per the key in env). */
export function useStripe(): Stripe {
  if (!client) {
    const key = useRuntimeConfig().stripeSecretKey;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    client = new Stripe(key);
  }
  return client;
}
