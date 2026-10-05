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
import { createRequire } from "node:module";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_MODE, get, guard, pgSsl } from "./_env.mjs";

// Repo root, resolved from this file so the scripts work from any cwd.
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pg = createRequire(`${PROJECT}/package.json`)("pg");

// Credentials and the SUPABASE_LOCAL guard live in scripts/_env.mjs.
guard(["NUXT_PUBLIC_SUPABASE_URL"]);
const env = {
  NUXT_PUBLIC_SUPABASE_URL: get("NUXT_PUBLIC_SUPABASE_URL") || "",
  ASK_DATABASE_URL: get("ASK_DATABASE_URL") || "",
  DATABASE_URL: get("DATABASE_URL") || "",
};

const ref = env.NUXT_PUBLIC_SUPABASE_URL.replace("https://", "").split(".")[0];
const raw = env.ASK_DATABASE_URL;

let dsn;
if (LOCAL_MODE) {
  // The local stack: the migrations make ask_readonly a login role but
  // deliberately set no password; the CI job sets a throwaway one
  // (ASK_READONLY_PASSWORD) with `supabase db query` after the reset, and
  // the DSN is built from the stack's own DB_URL host and port.
  guard(["DATABASE_URL"]);
  const password = process.env.ASK_READONLY_PASSWORD || "";
  if (!password) {
    console.error("SAFETY: SUPABASE_LOCAL is set but ASK_READONLY_PASSWORD is not — set the role's password on the local stack first.");
    process.exit(1);
  }
  const local = new URL(env.DATABASE_URL);
  dsn = `postgresql://ask_readonly:${encodeURIComponent(password)}@${local.hostname}:${local.port || 5432}${local.pathname || "/postgres"}`;
  console.log("local stack: connecting as ask_readonly on the stack's own database\n");
} else if (raw.startsWith("postgres")) {
  // Accept either a full DSN or a bare password (which is what is in .env now).
  dsn = raw;
} else if (raw) {
  dsn = `postgresql://ask_readonly.${ref}:${encodeURIComponent(raw)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;
  console.log("NOTE: ASK_DATABASE_URL is not a DSN; testing it as a password against the session pooler.\n");
} else {
  console.log("ASK_DATABASE_URL is empty.");
  process.exit(1);
}

async function connect() {
  // TLS for the hosted pooler; the local Postgres refuses it.
  const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
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
  // The privileged connection: the hosted pooler DSN, or the local stack's.
  const priv = new pg.Client({
    connectionString: env.DATABASE_URL,
    ssl: pgSsl(env.DATABASE_URL),
  });
  await priv.connect();

  // The predicate needs a threaded ask and a second staff member in the
  // same organisation. A populated database has both; a fresh stack has
  // neither, so the harness makes its own, tagged, and removes them after.
  // Never vacuous either way.
  const tag = `verify-ask-${Math.random().toString(16).slice(2, 10)}`;
  const fixture = { staff: [], asks: [] };
  const orgId = (await priv.query(`select id from organizations order by created_at limit 1`)).rows[0]?.id;
  if (orgId) {
    for (const label of ["owner", "other"]) {
      const { rows } = await priv.query(
        `insert into staff (organization_id, display_name, email, bookable, active)
         values ($1, $2, $3, false, true) returning id`,
        [orgId, `${tag} ${label}`, `${tag}-${label}@verify.test`],
      );
      fixture.staff.push(rows[0].id);
    }
    const { rows } = await priv.query(
      `insert into ask_queries (organization_id, staff_id, source, question, thread_id)
       values ($1, $2, 'llm', $3, gen_random_uuid()) returning id`,
      [orgId, fixture.staff[0], `${tag} question`],
    );
    fixture.asks.push(rows[0].id);
  }

  const owner = (
    await priv.query(
      `select thread_id, staff_id, organization_id
         from ask_queries
        where thread_id is not null and staff_id = $1
        order by created_at desc limit 1`,
      [fixture.staff[0] ?? "00000000-0000-4000-8000-000000000000"],
    )
  ).rows[0];

  const other = owner ? { id: fixture.staff[1] } : null;

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
  for (const id of fixture.asks) await priv.query(`delete from ask_queries where id = $1`, [id]);
  for (const id of fixture.staff) await priv.query(`delete from staff where id = $1`, [id]);
  await priv.end();
}

console.log("");
for (const r of results) console.log(`${r.state.padEnd(5)} ${r.name}\n      ${r.detail}`);
const bad = results.filter((r) => r.state !== "PASS").length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? ` — ${bad} NOT passing` : ""}`);
// A FAIL or an ERROR is a non-zero exit: CI must not read a hole as green.
process.exit(bad ? 1 : 0);
