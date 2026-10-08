/**
 * The Stripe sandbox gate, shared by the e2e-stripe CI job and the
 * @stripe journeys (docs/testing-design.md, "The money journeys" §3,
 * after Lokl's pattern): the key must be TEST MODE (sk_test_ or
 * rk_test_), and it must belong to the sandbox account named by
 * STRIPE_SANDBOX_ACCOUNT_ID — a key from any other account is refused.
 *
 * Nothing this module prints or throws carries a key or an account id.
 * Stripe's own authentication and permission errors quote a redacted
 * form of the key in their message, and GitHub masks only the exact
 * full secret — so a Stripe error is rethrown with its type, code and
 * HTTP status only, never its message.
 *
 *   STRIPE_SANDBOX_SECRET_KEY=… STRIPE_SANDBOX_ACCOUNT_ID=… node scripts/stripe-sandbox-check.mjs
 *
 * Locally, STRIPE_SECRET_KEY (a test key in apps/reserve/.env) is
 * accepted in place of the sandbox key, with the same checks.
 */
import Stripe from "stripe";

/** A Stripe error reduced to what is safe to print: type, code, HTTP status. */
export function stripeErrorSummary(e) {
  const type = e?.type ?? e?.rawType ?? "unknown";
  const code = e?.code ?? "none";
  const status = e?.statusCode ?? "none";
  return new Error(`Stripe refused the call (type ${type}, code ${code}, HTTP ${status})`);
}

export function sandboxKey() {
  const key = process.env.STRIPE_SANDBOX_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "";
  if (!key) throw new Error("No Stripe key: STRIPE_SANDBOX_SECRET_KEY (the stripe-sandbox environment) or a test-mode STRIPE_SECRET_KEY is needed");
  if (!/^(sk|rk)_test_/.test(key)) throw new Error("The Stripe key is not a test-mode key (sk_test_ or rk_test_); refusing to touch a live account");
  return key;
}

/** A client on the sandbox key, after the account check. */
export async function sandboxStripe() {
  const stripe = new Stripe(sandboxKey());
  const expected = process.env.STRIPE_SANDBOX_ACCOUNT_ID || "";
  if (!expected) throw new Error("STRIPE_SANDBOX_ACCOUNT_ID is not set; the account check cannot run");
  let account;
  try {
    account = await stripe.accounts.retrieve();
  } catch (e) {
    throw stripeErrorSummary(e);
  }
  if (account.id !== expected) throw new Error("The Stripe key belongs to a different account than STRIPE_SANDBOX_ACCOUNT_ID names; refusing");
  return stripe;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await sandboxStripe();
    console.log("Stripe sandbox check: test-mode key, account matches STRIPE_SANDBOX_ACCOUNT_ID.");
  } catch (e) {
    console.error(`Stripe sandbox check FAILED: ${e.message}`);
    process.exit(1);
  }
}
