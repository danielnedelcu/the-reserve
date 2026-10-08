import type Stripe from "stripe";
import { sandboxStripe } from "../../scripts/stripe-sandbox-check.mjs";

/**
 * The Stripe client the @stripe journeys use: the sandbox's test-mode
 * key after the account check (scripts/stripe-sandbox-check.mjs). The
 * ordinary e2e job never runs these journeys (--grep-invert @stripe);
 * the e2e-stripe job runs them with the stripe-sandbox environment's
 * key, and the app under test was started with the same key.
 */
let cached: Promise<Stripe> | null = null;
export function sandbox(): Promise<Stripe> {
  cached ??= sandboxStripe() as Promise<Stripe>;
  return cached;
}
