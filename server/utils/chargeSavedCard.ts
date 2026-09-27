import type Stripe from "stripe";

/**
 * Charge a client's saved card, off-session, in one confirmed step.
 *
 * The one Stripe call behind every card-on-file charge in the app: POS
 * checkout and the late-cancellation fee both go through here, so the
 * "money moves before any ledger write" sequence has a single
 * implementation rather than two that could drift (the design doc's
 * must-not-break: the fee engine is a new CALLER of the charge machinery,
 * not a new implementation).
 *
 * Never throws. A decline, a Stripe outage and an intent that ends in
 * any state but `succeeded` all come back as `{ ok: false }` with a
 * message fit to show a person; the caller decides what a failed charge
 * means for its own operation (checkout: 402, nothing written; the fee:
 * the appointment is NOT cancelled and the client is asked to call).
 *
 * `idempotencyKey` lets a caller make a retry safe: Stripe returns the
 * original intent instead of charging twice. Callers that can be raced
 * (two clicks on the same cancel link) MUST pass one.
 */
export async function chargeSavedCard(
  stripe: Stripe,
  input: {
    amountCents: number;
    stripeCustomerId: string;
    stripePaymentMethodId: string;
    metadata: Record<string, string>;
    idempotencyKey?: string;
  },
): Promise<
  { ok: true; paymentIntentId: string } | { ok: false; message: string }
> {
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: "usd",
        customer: input.stripeCustomerId,
        payment_method: input.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: input.metadata,
      },
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
    );
    if (intent.status !== "succeeded") {
      return {
        ok: false,
        message: `Card charge did not complete (${intent.status})`,
      };
    }
    return { ok: true, paymentIntentId: intent.id };
  } catch (error: unknown) {
    const stripeError = error as { message?: string };
    return { ok: false, message: stripeError.message ?? "Card was declined" };
  }
}
