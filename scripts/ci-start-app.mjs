// Starts the BUILT app (npm run build:check) against the LOCAL Supabase
// stack on the e2e test port, for verify:leads and the Playwright suite
// (docs/testing-design.md, PR B). Never the dev server, never the hosted
// project.
//
//   npm run app:start            start on 3300, wait until it answers
//   npm run app:stop             stop the one this script started
//
// Env comes from scripts/_env.mjs under SUPABASE_LOCAL=true: the stack's
// URL and keys (`supabase status -o env`, exported), and the guard refuses
// anything that is not localhost. The seeded organisation is looked up for
// LEADS_ORGANIZATION_ID; the values a harness must share with the app are
// written to node_modules/.cache/ci-app.env (append it to GITHUB_ENV, or
// `set -a; . node_modules/.cache/ci-app.env` locally).
//
// The one non-obvious line: NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX. The Supabase
// module names the auth cookie at BUILD time from the project URL the build
// saw; a build made on a laptop whose .env points at hosted would read every
// page as signed out against the local stack. The prefix is set here from
// the local URL, the same way @supabase/ssr derives it, so the browser's
// cookie and the app's expectation agree.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ROOT, get, guard, isLocalUrl, requireLocalStack } from "./_env.mjs";

const PORT = Number(process.env.E2E_PORT ?? 3300);
const BASE = `http://localhost:${PORT}`;
const cacheDir = `${ROOT}/node_modules/.cache`;
const pidFile = `${cacheDir}/ci-app.pid`;
const envFile = `${cacheDir}/ci-app.env`;

if (process.argv.includes("--stop")) {
  if (fs.existsSync(pidFile)) {
    for (const pid of fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid));
      } catch {
        // already gone
      }
    }
    fs.rmSync(pidFile);
    console.log("Stopped the app.");
  } else {
    console.log("Nothing to stop.");
  }
  process.exit(0);
}

requireLocalStack("starting the app for the harnesses and journeys");
guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const url = get("NUXT_PUBLIC_SUPABASE_URL");
const anonKey = get("NUXT_PUBLIC_SUPABASE_KEY");
const serviceKey = get("NUXT_SUPABASE_SECRET_KEY");
if (!isLocalUrl(url) || !anonKey || !serviceKey) {
  console.error("Refusing to start: needs the local stack's URL and keys in the environment.");
  process.exit(1);
}

const server = `${ROOT}/apps/reserve/.output-check/server/index.mjs`;
if (!fs.existsSync(server)) {
  console.error("No build: run `npm run build:check` first.");
  process.exit(1);
}

// The seeded organisation is the one lead capture belongs to.
const { createClient } = createRequire(`${ROOT}/package.json`)("@supabase/supabase-js");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { data: org, error } = await admin.from("organizations").select("id").order("created_at").limit(1).maybeSingle();
if (error || !org) {
  console.error("Refusing to start: no organisation in the local database (reset it from the migrations first).");
  process.exit(1);
}

const shared = {
  LEADS_ORGANIZATION_ID: org.id,
  LEADS_ALLOWED_ORIGINS: process.env.LEADS_ALLOWED_ORIGINS || "https://marketing.reserve.test",
  FORM_IP_PEPPER: process.env.FORM_IP_PEPPER || randomBytes(32).toString("hex"),
  E2E_BASE_URL: BASE,
};
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(envFile, Object.entries(shared).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  HOST: "127.0.0.1",
  NUXT_PUBLIC_SUPABASE_URL: url,
  NUXT_PUBLIC_SUPABASE_KEY: anonKey,
  NUXT_SUPABASE_SECRET_KEY: serviceKey,
  NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`,
  NUXT_PUBLIC_SITE_URL: BASE,
  // The app's own runtimeConfig keys are read as NUXT_<KEY> at run time.
  NUXT_FORM_IP_PEPPER: shared.FORM_IP_PEPPER,
  NUXT_LEADS_ORGANIZATION_ID: shared.LEADS_ORGANIZATION_ID,
  NUXT_LEADS_ALLOWED_ORIGINS: shared.LEADS_ALLOWED_ORIGINS,
  NUXT_COMMUNICATIONS_JOB_SECRET: process.env.COMMUNICATIONS_JOB_SECRET || randomBytes(32).toString("hex"),
  // No email leaves a test run; sendMail logs and returns false without a key.
  RESEND_API_KEY: "",
  MAIL_FROM: "",
  // No Stripe key in a test app unless a money journey supplies a test one.
  // A secret or a restricted key, test mode either way (the e2e-stripe job
  // hands over a restricted rk_test_ one). The app reads it from
  // runtimeConfig.stripeSecretKey, whose RUN-TIME override is
  // NUXT_STRIPE_SECRET_KEY; the bare name only reaches the app when it was
  // in the environment at BUILD time (a laptop's .env), which is how the
  // first e2e-stripe run started the app with no key at all (2026-10-08).
  STRIPE_SECRET_KEY: /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "") ? process.env.STRIPE_SECRET_KEY : "",
  NUXT_STRIPE_SECRET_KEY: /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "") ? process.env.STRIPE_SECRET_KEY : "",
};

const log = fs.openSync(`${ROOT}/apps/reserve/.output-check/server.log`, "w");
const child = spawn(process.execPath, [server], { env, stdio: ["ignore", log, log], detached: true });
child.unref();
fs.writeFileSync(pidFile, `${child.pid}\n`);

// Up when the port answers with any HTTP status.
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
    console.log(`The app is up on ${BASE} (pid ${child.pid}); env for harnesses in ${envFile}.`);
    process.exit(0);
  } catch {
    if (Date.now() > deadline) {
      console.error(`The app did not start within a minute. See apps/reserve/.output-check/server.log.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
