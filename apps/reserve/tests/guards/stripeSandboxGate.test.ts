// @vitest-environment node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stripeErrorSummary } from "../../../../scripts/stripe-sandbox-check.mjs";

/**
 * The Stripe sandbox gate (scripts/stripe-sandbox-check.mjs) must never
 * print any part of the key it was handed. Stripe's authentication and
 * permission errors quote a REDACTED form of the key in their message —
 * the prefix, asterisks, the last four — and GitHub masks only the exact
 * full secret, so that redacted form would reach the log. The gate
 * rethrows a Stripe error with its type, code and HTTP status only.
 *
 * Two checks, applied to every case: the output never contains the key's
 * last four characters, and it never contains a key prefix followed by a
 * key character or an asterisk (the gate's own "(sk_test_ or rk_test_)"
 * wording is a prefix followed by a bracket or a space, and passes).
 *
 * The dangerous path is tested deterministically, by feeding the
 * sanitiser constructed Stripe errors shaped like the real ones. The one
 * real-Stripe case asserts the answer WAS a 401 authentication error, so
 * a connection failure fails it rather than passing by accident.
 */

const GATE = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../scripts/stripe-sandbox-check.mjs");
const run = promisify(execFile);
const REDACTED_KEY = /\b(sk|rk)_(test|live)_[A-Za-z0-9*]/;

async function gate(env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [GATE], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function expectNoKeyIn(out: string, key: string): void {
  expect(out, "the output carries the key's last four").not.toContain(key.slice(-4));
  expect(out, "the output carries a key prefix followed by a key character or an asterisk").not.toMatch(REDACTED_KEY);
}

/** A Stripe error as the SDK raises it: the message quotes the key the way Stripe redacts it. */
function stripeError(type: string, statusCode: number, code: string | undefined, key: string) {
  const redacted = `${key.slice(0, 8)}${"*".repeat(12)}${key.slice(-4)}`;
  const err = new Error(
    type === "StripePermissionError"
      ? `This API key does not have the required permissions for this endpoint. (API key: ${redacted})`
      : `Invalid API Key provided: ${redacted}`,
  ) as Error & { type: string; rawType: string; statusCode: number; code?: string };
  err.type = type;
  err.rawType = type === "StripePermissionError" ? "invalid_request_error" : "invalid_request_error";
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

describe("the Stripe sandbox gate prints no part of the key", () => {
  it("sanitises a constructed authentication error to its type, code and status (no network)", () => {
    const key = `rk_test_${randomBytes(24).toString("hex")}`;
    const out = stripeErrorSummary(stripeError("StripeAuthenticationError", 401, undefined, key)).message;
    expect(out).toBe("Stripe refused the call (type StripeAuthenticationError, code none, HTTP 401)");
    expectNoKeyIn(out, key);
  });

  it("sanitises a constructed permission error the same way (no network)", () => {
    const key = `rk_test_${randomBytes(24).toString("hex")}`;
    const out = stripeErrorSummary(stripeError("StripePermissionError", 403, "api_key_insufficient_permissions", key)).message;
    expect(out).toBe("Stripe refused the call (type StripePermissionError, code api_key_insufficient_permissions, HTTP 403)");
    expectNoKeyIn(out, key);
  });

  it("refuses a made-up rk_test_ key after Stripe answers 401, printing only the error's type, code and status", async () => {
    const key = `rk_test_${randomBytes(24).toString("hex")}`;
    const { code, out } = await gate({ STRIPE_SANDBOX_SECRET_KEY: key, STRIPE_SANDBOX_ACCOUNT_ID: "acct_doesnotmatter" });
    expect(code).toBe(1);
    // The answer must be Stripe's 401, not a connection failure that would pass the leak checks by printing nothing.
    expect(out).toContain("Stripe refused the call (type StripeAuthenticationError, code none, HTTP 401)");
    expectNoKeyIn(out, key);
    expect(out).not.toContain("acct_doesnotmatter");
  }, 40_000);

  it("refuses a key that is not test mode without touching Stripe, and prints none of it", async () => {
    const key = `rk_live_${randomBytes(24).toString("hex")}`;
    const { code, out } = await gate({ STRIPE_SANDBOX_SECRET_KEY: key, STRIPE_SANDBOX_ACCOUNT_ID: "acct_x" });
    expect(code).toBe(1);
    expect(out).toContain("not a test-mode key (sk_test_ or rk_test_)");
    expectNoKeyIn(out, key);
  });

  it("refuses to run with no key at all", async () => {
    const { code, out } = await gate({});
    expect(code).toBe(1);
    expect(out).toContain("No Stripe key");
    expect(out).not.toMatch(REDACTED_KEY);
  });
});
