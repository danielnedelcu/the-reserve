/**
 * Credentials for the verify:* harnesses, from ONE place.
 *
 * Resolution order, per key:
 *   1. process.env — the app's own names (NUXT_PUBLIC_SUPABASE_URL …) or
 *      the Supabase CLI's names from `supabase status -o env`
 *      (API_URL, ANON_KEY / PUBLISHABLE_KEY, SERVICE_ROLE_KEY / SECRET_KEY,
 *      DB_URL), which is how CI hands the local stack to a harness;
 *   2. apps/reserve/.env — the laptop case, against the hosted project.
 *
 * SUPABASE_LOCAL mode (set by the CI job, or by hand when running against
 * a local stack) is the safety guard: the Supabase URL and the database
 * URL must have come from the ENVIRONMENT, not the file, and both must
 * point at localhost. A runner that forgot the export, or a shell whose
 * .env points at the hosted project, fails loudly before any query runs.
 * Outside that mode nothing changes: the harnesses run against whatever
 * the file names, as they always have.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, "apps/reserve/.env");

export const LOCAL_MODE = /^(1|true|yes)$/i.test(process.env.SUPABASE_LOCAL ?? "");

/** process.env names that may stand in for each app-side name. */
const ALIASES = {
  NUXT_PUBLIC_SUPABASE_URL: ["NUXT_PUBLIC_SUPABASE_URL", "API_URL"],
  NUXT_PUBLIC_SUPABASE_KEY: ["NUXT_PUBLIC_SUPABASE_KEY", "ANON_KEY", "PUBLISHABLE_KEY"],
  NUXT_SUPABASE_SECRET_KEY: ["NUXT_SUPABASE_SECRET_KEY", "SERVICE_ROLE_KEY", "SECRET_KEY"],
  DATABASE_URL: ["DATABASE_URL", "DB_URL"],
};
/** File names that may stand in for each app-side name. */
const FILE_ALIASES = {
  DATABASE_URL: ["DATABASE_URL", "TBLS_DSN"],
};

let fileCache = null;
function fromFile() {
  if (fileCache) return fileCache;
  fileCache = {};
  if (!existsSync(ENV_FILE)) return fileCache;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    fileCache[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return fileCache;
}

/** The value and where it came from: "env", "file", or null when unset. */
export function resolve(key) {
  for (const name of ALIASES[key] ?? [key]) {
    const v = process.env[name];
    if (v !== undefined && v !== "") return { value: v, source: "env", name };
  }
  const file = fromFile();
  for (const name of FILE_ALIASES[key] ?? [key]) {
    if (file[name]) return { value: file[name], source: "file", name };
  }
  return { value: undefined, source: null, name: key };
}

/** Just the value. */
export function get(key) {
  return resolve(key).value;
}

export function isLocalUrl(value) {
  try {
    const h = new URL(value).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * pg's ssl option for a DSN: the hosted pooler needs TLS (self-signed chain),
 * the local Postgres refuses it.
 */
export function pgSsl(dsn) {
  return isLocalUrl(dsn) ? false : { rejectUnauthorized: false };
}

function refuse(message) {
  console.error(`SAFETY: ${message}`);
  console.error("No checks were run.");
  process.exit(1);
}

/**
 * Enforce the SUPABASE_LOCAL guard on the URLs a harness is about to use.
 * Call it once, first, with the keys the harness connects through.
 */
export function guard(keys = ["NUXT_PUBLIC_SUPABASE_URL"]) {
  if (!LOCAL_MODE) return;
  for (const key of keys) {
    const r = resolve(key);
    if (!r.value) refuse(`SUPABASE_LOCAL is set but ${key} is not in the environment (run \`supabase status -o env\` and export it).`);
    if (r.source !== "env") refuse(`SUPABASE_LOCAL is set but ${key} came from apps/reserve/.env, not the environment — refusing to fall back to a hosted value.`);
    if (!isLocalUrl(r.value)) refuse(`SUPABASE_LOCAL is set but ${key} (${r.name}) does not point at localhost — refusing to run against a non-local database.`);
  }
}

/**
 * The three Supabase credentials every harness needs, guarded. Exits with
 * a clear message when any is missing.
 */
export function supabaseEnv() {
  guard(["NUXT_PUBLIC_SUPABASE_URL"]);
  const url = get("NUXT_PUBLIC_SUPABASE_URL");
  const anonKey = get("NUXT_PUBLIC_SUPABASE_KEY");
  const serviceKey = get("NUXT_SUPABASE_SECRET_KEY");
  if (!url || !anonKey || !serviceKey) {
    console.error(
      "FATAL: need NUXT_PUBLIC_SUPABASE_URL, NUXT_PUBLIC_SUPABASE_KEY and NUXT_SUPABASE_SECRET_KEY — in the environment, or in apps/reserve/.env",
    );
    process.exit(1);
  }
  return { url, anonKey, serviceKey };
}
