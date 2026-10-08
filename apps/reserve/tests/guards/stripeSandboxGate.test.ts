// @vitest-environment node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The Stripe sandbox gate (scripts/stripe-sandbox-check.mjs) must never
 * print any part of the key it was handed. Stripe's authentication and
 * permission errors quote a redacted form of the key in their message,
 * and GitHub masks only the exact full secret, so the gate rethrows a
 * Stripe error with its type, code and HTTP status only. The invalid-key
 * case here reaches Stripe for real (an unauthenticated request with a
 * made-up key, which Stripe answers 401); the other two never leave the
 * process.
 */

const GATE = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../scripts/stripe-sandbox-check.mjs");
const run = promisify(execFile);

async function gate(env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [GATE], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/** Every 6-character window of the secret part: none may appear in the output. */
function fragmentsOf(key: string): string[] {
  const secret = key.replace(/^(sk|rk)_test_/, "");
  const out: string[] = [];
  for (let i = 0; i + 6 <= secret.length; i++) out.push(secret.slice(i, i + 6));
  return out;
}

describe("the Stripe sandbox gate prints no part of the key", () => {
  it("refuses an invalid rk_test_ key after Stripe rejects it, naming only the error's type, code and status", async () => {
    const key = `rk_test_${randomBytes(24).toString("hex")}`;
    const { code, out } = await gate({ STRIPE_SANDBOX_SECRET_KEY: key, STRIPE_SANDBOX_ACCOUNT_ID: "acct_doesnotmatter" });
    expect(code).toBe(1);
    expect(out).toContain("Stripe sandbox check FAILED");
    expect(out).toContain("Stripe refused the call (type ");
    expect(out).not.toContain(key);
    for (const fragment of fragmentsOf(key)) expect(out, `output carries a fragment of the key: ${fragment}`).not.toContain(fragment);
    expect(out).not.toContain("acct_doesnotmatter");
  }, 40_000);

  it("refuses a key that is not test mode without touching Stripe, and prints none of it", async () => {
    const key = `rk_live_${randomBytes(24).toString("hex")}`;
    const { code, out } = await gate({ STRIPE_SANDBOX_SECRET_KEY: key, STRIPE_SANDBOX_ACCOUNT_ID: "acct_x" });
    expect(code).toBe(1);
    expect(out).toContain("not a test-mode key");
    expect(out).not.toContain(key);
    for (const fragment of fragmentsOf(key)) expect(out).not.toContain(fragment);
  });

  it("refuses to run with no key at all", async () => {
    const { code, out } = await gate({});
    expect(code).toBe(1);
    expect(out).toContain("No Stripe key");
  });
});
