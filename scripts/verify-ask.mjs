/**
 * Verifies the ask_readonly boundary against the live database.
 * Run: npm run verify:ask
 *
 * Read-only. Prints PASS/FAIL/ERROR only — never the DSN, never a
 * password, never row contents.
 *
 * Harness rule: a check may only PASS if we actually connected and the
 * DATABASE made the decision. A connection failure is ERROR, never PASS.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this file so the scripts work from any cwd.
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pg = createRequire(`${PROJECT}/package.json`)("pg");

const env = Object.fromEntries(
  fs
    .readFileSync(`${PROJECT}/.env`, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const ref = (env.NUXT_PUBLIC_SUPABASE_URL || "").replace("https://", "").split(".")[0];
const raw = env.ASK_DATABASE_URL || "";

// Accept either a full DSN or a bare password (which is what is in .env now).
let dsn;
if (raw.startsWith("postgres")) {
  dsn = raw;
} else if (raw) {
  dsn = `postgresql://ask_readonly.${ref}:${encodeURIComponent(raw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;
  console.log("NOTE: ASK_DATABASE_URL is not a DSN; testing it as a password against the session pooler.\n");
} else {
  console.log("ASK_DATABASE_URL is empty.");
  process.exit(1);
}

async function connect() {
  const c = new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

// --- gate: one real connection, or we report nothing ------------------
let probe;
try {
  probe = await connect();
} catch (e) {
  console.log(`CANNOT CONNECT: ${e.message.split("\n")[0]}`);
  console.log("No boundary checks were run.");
  process.exit(1);
}
const who = await probe.query("select current_user::text cu, session_user::text su");
await probe.end();
console.log(`connected as session_user=${who.rows[0].su}, current_user=${who.rows[0].cu}\n`);

const results = [];
const add = (name, state, detail) => results.push({ name, state, detail });

async function mustSucceed(name, sql, check) {
  let c;
  try {
    c = await connect();
  } catch (e) {
    return add(name, "ERROR", `connect failed: ${e.message.split("\n")[0]}`);
  }
  try {
    const r = await c.query(sql);
    const d = check ? check(r) : "ok";
    add(name, d === false ? "FAIL" : "PASS", d === false ? "unexpected result" : d);
  } catch (e) {
    add(name, "FAIL", `threw: ${e.message.split("\n")[0]}`);
  } finally {
    await c.end().catch(() => {});
  }
}

async function mustRefuse(name, sql) {
  let c;
  try {
    c = await connect();
  } catch (e) {
    return add(name, "ERROR", `connect failed: ${e.message.split("\n")[0]}`);
  }
  try {
    await c.query(sql);
    add(name, "FAIL", "!! SUCCEEDED — boundary hole");
  } catch (e) {
    add(name, "PASS", `refused: ${e.message.split("\n")[0]}`);
  } finally {
    await c.end().catch(() => {});
  }
}

await mustSucceed(
  "session_user is ask_readonly (the leash)",
  "select session_user::text su",
  (r) => (r.rows[0].su === "ask_readonly" ? "ask_readonly" : `got ${r.rows[0].su}`),
);
await mustSucceed("default_transaction_read_only = on", "show default_transaction_read_only",
  (r) => (r.rows[0].default_transaction_read_only === "on" ? "on" : false));
await mustSucceed("statement_timeout = 10s", "show statement_timeout",
  (r) => (r.rows[0].statement_timeout === "10s" ? "10s" : `got ${r.rows[0].statement_timeout}`));

// The escalation that broke the first design.
await mustRefuse("set_config('role','service_role') refused", "select set_config('role','service_role',true)");
await mustRefuse("SET ROLE service_role refused", "set role service_role");
await mustRefuse("SET ROLE postgres refused", "set role postgres");

// Allowlist: permitted.
await mustSucceed("SELECT on allowlisted table permitted", "select count(*)::int n from clients",
  (r) => `permitted (RLS yields ${r.rows[0].n} rows with no claims set)`);

// Allowlist: refused.
for (const [label, sql] of [
  ["client_notes (PHI) refused", "select count(*) from client_notes"],
  ["messages refused", "select count(*) from messages"],
  ["staff_invites refused", "select count(*) from staff_invites"],
  ["audit_log refused", "select count(*) from audit_log"],
  ["ask_queries refused", "select count(*) from ask_queries"],
  ["client_payment_methods refused", "select count(*) from client_payment_methods"],
  ["auth.users refused", "select count(*) from auth.users"],
]) await mustRefuse(label, sql);

await mustRefuse("write refused (read-only)", "update clients set active = active");

// --- thread scoping ----------------------------------------------------
// Follow-up context is loaded from ask_queries by the ROUTE, on the service
// role — ask_readonly cannot see that table, so RLS is not filtering here
// and the predicate has to. This checks the predicate the way the route
// writes it: thread_id alone would let anyone who guessed or reused an id
// pull another admin's questions and SQL into their own prompt.
//
// Deliberately asserts BOTH directions. "B sees nothing" alone would also
// pass if the query were simply broken and returned nothing for everyone.
{
  const priv = new pg.Client({
    connectionString: env.TBLS_DSN,
    ssl: { rejectUnauthorized: false },
  });
  await priv.connect();

  const owner = (
    await priv.query(
      `select thread_id, staff_id, organization_id
         from ask_queries
        where thread_id is not null
        order by created_at desc limit 1`,
    )
  ).rows[0];

  const other = owner
    ? (
        await priv.query(
          `select id from staff
            where organization_id = $1 and id <> $2 limit 1`,
          [owner.organization_id, owner.staff_id],
        )
      ).rows[0]
    : null;

  const asStaff = async (staffId) =>
    (
      await priv.query(
        `select count(*)::int n from ask_queries
          where thread_id = $1 and staff_id = $2 and organization_id = $3`,
        [owner.thread_id, staffId, owner.organization_id],
      )
    ).rows[0].n;

  if (!owner) {
    add("thread scoping", "ERROR", "no threaded asks yet — run one first");
  } else if (!other) {
    add("thread scoping", "ERROR", "no second staff member to test against");
  } else {
    const mine = await asStaff(owner.staff_id);
    const theirs = await asStaff(other.id);
    add(
      "thread loads for its owner",
      mine > 0 ? "PASS" : "FAIL",
      `${mine} row(s) — a zero here would make the next check meaningless`,
    );
    add(
      "same thread id refused to another staff member",
      theirs === 0 ? "PASS" : "FAIL",
      theirs === 0
        ? "0 rows — guessing the id is not enough"
        : `!! ${theirs} row(s) leaked`,
    );
  }
  await priv.end();
}

console.log("");
for (const r of results) console.log(`${r.state.padEnd(5)} ${r.name}\n      ${r.detail}`);
const bad = results.filter((r) => r.state !== "PASS").length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? ` — ${bad} NOT passing` : ""}`);
