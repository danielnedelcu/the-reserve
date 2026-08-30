/**
 * End-to-end exercise of /api/ask against the running dev server.
 *
 * Mints real Supabase sessions with the service-role key (magiclink ->
 * verifyOtp) so the route's own auth and permission gates run for real.
 * Read-only with respect to business data; it does write ask_queries rows,
 * which is the point — the log is part of what is being verified.
 *
 * Run: node scripts/e2e-ask.mjs
 * Prints results only — never tokens, keys, or client PII.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${PROJECT}/package.json`);
const { createClient } = require("@supabase/supabase-js");
const pg = require("pg");

const L = fs.readFileSync(`${PROJECT}/.env`, "utf8").split("\n");
const g = (k) => {
  const l = L.find((x) => x.trim().startsWith(k + "=")) || "";
  return l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
};

const URL_ = g("NUXT_PUBLIC_SUPABASE_URL");
const ANON = g("NUXT_PUBLIC_SUPABASE_KEY");
const SECRET = g("NUXT_SUPABASE_SECRET_KEY");
const REF = URL_.replace("https://", "").split(".")[0];
const BASE = process.env.ASK_E2E_BASE ?? "http://localhost:3000";

const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });

/** Emails of one staff member who holds ask.query, and one who does not. */
async function findSubjects() {
  const c = new pg.Client({ connectionString: g("TBLS_DSN"), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (having) =>
    (
      await c.query(`
      select s.email
        from staff s
       where s.active and s.user_id is not null
         and ${having} (
           select 1 from staff_roles sr
           join role_permissions rp on rp.role_id = sr.role_id
          where sr.staff_id = s.id and rp.permission_key = 'ask.query')
       limit 1`)
    ).rows[0]?.email ?? null;
  const withPerm = await q("exists");
  const withoutPerm = await q("not exists");
  await c.end();
  return { withPerm, withoutPerm };
}

/** A real signed-in session, as the app's cookie. */
async function sessionCookie(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data: v, error: vErr } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: "magiclink",
  });
  if (vErr) throw new Error(`verifyOtp: ${vErr.message}`);
  const s = v.session;
  // @supabase/ssr cookie format, chunked if oversized.
  const payload = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64");
  const name = `sb-${REF}-auth-token`;
  if (payload.length <= 3180) return `${name}=${encodeURIComponent(payload)}`;
  const chunks = payload.match(/.{1,3180}/g);
  return chunks.map((ch, i) => `${name}.${i}=${encodeURIComponent(ch)}`).join("; ");
}

async function ask(cookie, body) {
  const r = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON error body */ }
  return { status: r.status, json };
}

const line = (s) => console.log(s);

const { withPerm, withoutPerm } = await findSubjects();
line(`ask.query holder found: ${withPerm ? "yes" : "NO"}`);
line(`non-holder found      : ${withoutPerm ? "yes" : "no (skipping 403 check)"}\n`);

// --- 1. permission gate ----------------------------------------------
line("=== 1. permission gate ===");
const anonRes = await ask(null, { presetId: "clients.new_this_month" });
line(`unauthenticated            -> ${anonRes.status} ${anonRes.json?.statusMessage ?? ""}`);

if (withoutPerm) {
  const c = await sessionCookie(withoutPerm);
  const res = await ask(c, { presetId: "clients.new_this_month" });
  line(`signed in, no ask.query    -> ${res.status} ${res.json?.statusMessage ?? ""}`);
}

const adminCookie = await sessionCookie(withPerm);
line(`signed in, with ask.query  -> (used for the runs below)\n`);

// --- 2. preset path ---------------------------------------------------
line("=== 2. preset path (no LLM) ===");
const t0 = Date.now();
const preset = await ask(adminCookie, { presetId: "clients.new_this_month", route: "/clients" });
line(`status    : ${preset.status}`);
line(`source    : ${preset.json?.source}`);
line(`caption   : ${JSON.stringify(preset.json?.answer)}`);
line(`columns   : ${JSON.stringify(preset.json?.columns)}`);
line(`rows      : ${preset.json?.rows?.length}`);
line(`sql shown : ${preset.json?.sql === null ? "null (correct — presets are human-written)" : "NOT NULL"}`);
line(`elapsed   : ${Date.now() - t0}ms\n`);

// --- 3. free-text path ------------------------------------------------
line("=== 3. free-text path (generateSql -> Anthropic) ===");
const question = "How many clients do we have in total?";
const t1 = Date.now();
const free = await ask(adminCookie, { question, route: "/clients" });
line(`question  : ${JSON.stringify(question)}`);
line(`status    : ${free.status}`);
line(`source    : ${free.json?.source}`);
line(`caption   : ${JSON.stringify(free.json?.answer)}`);
line(`columns   : ${JSON.stringify(free.json?.columns)}`);
line(`rows      : ${free.json?.rows?.length}`);
line(`generated SQL:\n${(free.json?.sql ?? "(none)").trim()}`);
line(`elapsed   : ${Date.now() - t1}ms\n`);

// --- 4. a question the data cannot answer -----------------------------
line("=== 4. unanswerable question (should decline, not invent) ===");
const decline = await ask(adminCookie, {
  question: "What did clients write in their health notes about shoulder pain?",
  route: "/clients",
});
line(`status    : ${decline.status}`);
line(`sql       : ${decline.json?.sql === null ? "null (declined)" : "generated anyway"}`);
line(`answer    : ${JSON.stringify(decline.json?.answer)}\n`);

// --- 5. the audit log -------------------------------------------------
line("=== 5. ask_queries log ===");
const c = new pg.Client({ connectionString: g("TBLS_DSN"), ssl: { rejectUnauthorized: false } });
await c.connect();
const rows = await c.query(`
  select source, preset_id, question, row_count, duration_ms,
         (generated_sql is not null) as has_sql, error
    from ask_queries order by created_at desc limit 5`);
await c.end();
for (const r of rows.rows) {
  line(
    `  ${r.source.padEnd(6)} ${(r.preset_id ?? r.question ?? "").slice(0, 42).padEnd(44)}` +
      `rows=${String(r.row_count ?? "-").padEnd(4)} ${String(r.duration_ms ?? "-").padEnd(6)}ms ` +
      `sql=${r.has_sql}${r.error ? ` err=${r.error.slice(0, 40)}` : ""}`,
  );
}
