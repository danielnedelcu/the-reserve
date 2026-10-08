/**
 * verify-build-secrets — nothing secret is baked into a build, and the
 * built server says what it is missing (docs/deployment.md, "Secrets at
 * runtime").
 *
 *   1. SENTINEL BUILD. Every setting in shared/config/settings.ts (and
 *      every bare pre-2026-10-08 name) is set in the build's environment
 *      to a distinct fake value, and the app is built into .output-check
 *      (scripts/build-check.mjs). A build with NO secrets would prove
 *      nothing; a build with sentinels proves none can land.
 *   2. SCAN. The whole .output-check is searched for every sentinel and
 *      for secret-shaped strings (Stripe, Resend, Anthropic, Supabase
 *      secret keys, JWTs, connection strings with credentials), and the
 *      inlined runtime config in the Nitro bundle must hold an empty
 *      string for every private setting.
 *   3. STARTUP. The built server starts with every setting blank except
 *      the Stripe webhook's signing secret (a sentinel, so the webhook
 *      gets past its own check to the Stripe client); its startup report
 *      must name every blank one as NOT SET, two routes that check their
 *      setting before anything else must answer 503 naming it, and the
 *      Stripe webhook — the one Stripe-dependent route reachable without
 *      a session or a database — must answer 503 naming
 *      NUXT_STRIPE_SECRET_KEY, never a generic 500. Then the server stops.
 *
 * Exit 1 on any finding. Prints names, counts and status codes; never a
 * value. The build it leaves behind is a normal one (nothing baked), so
 * the CI job starts the app from it.
 *
 *   npm run verify:build-secrets            (--no-build: scan and start an existing .output-check)
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./_env.mjs";
import { SETTINGS } from "../apps/reserve/shared/config/settings.ts";

const OUT = join(ROOT, "apps/reserve/.output-check");
const NITRO = join(OUT, "server/chunks/nitro/nitro.mjs");
const PORT = 3301;
const noBuild = process.argv.includes("--no-build");
let failed = 0;
const problems = [];
const check = (name, ok, detail = "") => { if (ok) console.log(`  PASS  ${name}`); else { failed++; problems.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); } };

// ---- 1. the sentinel build
// Sentinels for every PRIVATE setting, under its NUXT_ name and its bare
// pre-2026-10-08 name. Public settings are inlined by design (the browser
// needs them), so they get ordinary valid values instead — the Supabase
// module refuses to build on an invalid URL.
const sentinels = new Map(); // env name -> fake value, unique and unlike anything real
const publicEnv = { NUXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NUXT_PUBLIC_SUPABASE_KEY: "public-key-for-the-sentinel-build", NUXT_PUBLIC_SITE_URL: "http://localhost:3300", NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_sentinel_build" };
for (const s of SETTINGS) {
  if (s.config.startsWith("public.")) continue;
  sentinels.set(s.env, `SENTINEL-${s.env}-${randomBytes(8).toString("hex")}`);
  const bare = s.env.replace(/^NUXT_/, "");
  sentinels.set(bare, `SENTINEL-${bare}-${randomBytes(8).toString("hex")}`);
}
if (!noBuild) {
  console.log(`\nverify-build-secrets — building with ${sentinels.size} sentinel values in the environment (${sentinels.size / 2} private settings, each under its NUXT_ and its bare name)`);
  const env = { ...process.env, ...publicEnv };
  for (const [k, v] of sentinels) env[k] = v;
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/build-check.mjs")], { env, stdio: "inherit" });
  if (r.status !== 0) { console.error("the sentinel build failed"); process.exit(1); }
} else {
  console.log("\nverify-build-secrets — scanning the existing .output-check (--no-build; sentinel search is vacuous without the build)");
}

// ---- 2. the scan
const files = [];
(function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) walk(p); else files.push(p); } })(OUT);
const texts = files.map((f) => [f, readFileSync(f, "latin1")]);
const hits = (needle) => texts.filter(([, t]) => t.includes(needle)).map(([f]) => f.slice(OUT.length + 1));
if (!noBuild) {
  let leaked = [];
  for (const [name, value] of sentinels) { const where = hits(value); if (where.length) leaked.push(`${name} in ${where.slice(0, 3).join(", ")}`); }
  check(`none of the ${sentinels.size} sentinel values is in the built output`, leaked.length === 0, leaked.join("; "));
}
const SHAPES = [
  ["a Stripe secret or restricted key", /\b(sk|rk)_(test|live)_[A-Za-z0-9]{16,}/],
  ["a Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{16,}/],
  ["a Resend API key", /\bre_[A-Za-z0-9]{20,}/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ["a Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["a connection string with credentials", /\bpostgres(ql)?:\/\/[^\s"'/]+:[^\s"'@]+@/],
];
for (const [what, re] of SHAPES) {
  const where = texts.filter(([, t]) => re.test(t)).map(([f]) => f.slice(OUT.length + 1));
  check(`no string shaped like ${what} in the built output`, where.length === 0, where.slice(0, 3).join(", "));
}
{
  const src = readFileSync(NITRO, "utf8");
  const i = src.indexOf("_inlineRuntimeConfig = {"), j = src.indexOf("\n};", i);
  const block = i >= 0 && j > i ? src.slice(i, j + 3) : "";
  check("the Nitro bundle inlines a runtime config block", block.length > 0);
  const privateKeys = SETTINGS.filter((s) => !s.config.startsWith("public.")).map((s) => s.config.split(".").pop());
  const nonEmpty = privateKeys.filter((k) => new RegExp(`"${k}":\\s*"[^"]+"`).test(block));
  check(`every private setting is inlined as an empty string (${privateKeys.length} keys)`, nonEmpty.length === 0, `set in the bundle: ${nonEmpty.join(", ")}`);
}

// ---- 3. the startup report and two fail-closed routes, with everything blank
const webhookSentinel = `whsec_sentinel_${randomBytes(12).toString("hex")}`;
const blank = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1", NUXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NUXT_PUBLIC_SUPABASE_KEY: "not-a-key", NUXT_STRIPE_WEBHOOK_SECRET: webhookSentinel };
const server = spawn(process.execPath, [join(OUT, "server/index.mjs")], { env: blank, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); } return pred(); };
try {
  const reported = await until(() => /\[config\] \d+ setting\(s\) set; \d+ not set|\[config\] every setting is set/.test(log), 20_000);
  check("the built server prints its startup report", reported, "no [config] summary line within 20 s");
  const expectedMissing = SETTINGS.filter((s) => !s.config.startsWith("public.supabase.") && s.env !== "NUXT_STRIPE_WEBHOOK_SECRET");
  check("the report counts the webhook secret as set and prints no part of it", log.includes("[config] NUXT_STRIPE_WEBHOOK_SECRET: NOT SET") === false && !log.includes(webhookSentinel));
  const notReported = expectedMissing.filter((s) => !log.includes(`[config] ${s.env}: NOT SET`));
  check(`the report names every blank setting as NOT SET (${expectedMissing.length})`, notReported.length === 0, notReported.map((s) => s.env).join(", "));
  check("the report prints no value (no sentinel, no key shape)", ![...sentinels.values()].some((v) => log.includes(v)) && !SHAPES.some(([, re]) => re.test(log)));
  const up = await until(() => { try { return true; } catch { return false; } }, 0);
  const probe = async (path, expectName, headers = {}) => {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
        const body = await r.text();
        return { status: r.status, names: body.includes(expectName) };
      } catch { await new Promise((res) => setTimeout(res, 200)); }
    }
    return { status: 0, names: false };
  };
  const resend = await probe("/api/webhooks/resend", "NUXT_RESEND_WEBHOOK_SECRET");
  check("POST /api/webhooks/resend with no secret answers 503 naming NUXT_RESEND_WEBHOOK_SECRET", resend.status === 503 && resend.names, `status ${resend.status}`);
  const jobs = await probe("/api/jobs/communications", "NUXT_COMMUNICATIONS_JOB_SECRET");
  check("POST /api/jobs/communications with no secret answers 503 naming NUXT_COMMUNICATIONS_JOB_SECRET", jobs.status === 503 && jobs.names, `status ${jobs.status}`);
  const webhook = await probe("/api/stripe/webhook", "NUXT_STRIPE_SECRET_KEY", { "stripe-signature": "t=1,v1=0000" });
  check("POST /api/stripe/webhook with its signing secret but no Stripe key answers 503 naming NUXT_STRIPE_SECRET_KEY (not a generic 500)", webhook.status === 503 && webhook.names, `status ${webhook.status}`);
  void up;
} finally {
  server.kill("SIGTERM");
}
console.log(`\n${failed ? `${failed} FAILED:\n  - ${problems.join("\n  - ")}` : "verify-build-secrets: nothing baked, everything reported"}`);
process.exit(failed ? 1 : 0);
