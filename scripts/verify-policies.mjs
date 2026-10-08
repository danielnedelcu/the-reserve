/**
 * verify-policies — the guard behind docs/design/policy-sweep-design.md.
 *
 * Reads pg_policies for every table in public and fails, naming the
 * table, the policy and the clause, on any helper call that is not
 * wrapped as a scalar subquery — current_org_id(), current_staff_id(),
 * has_permission(), is_admin(), auth.uid(), is_conversation_participant()
 * — because Postgres evaluates a bare call PER ROW and a wrapped one
 * once per statement (255ms → 0.7ms on a 10,000-row count). The next
 * policy written the old way fails CI instead of shipping a per-row cost.
 *
 * An allowlist covers the correlated calls that CANNOT be hoisted, each
 * with its reason; an allowlisted policy that no longer matches fails
 * too, so the list cannot go stale. It also fails on a public table
 * without RLS, and on an RLS table with no policy that is not in the
 * service-role-only list — a table cannot ship open, or closed by
 * omission, unnoticed.
 *
 * Runs against whatever scripts/_env.mjs resolves (hosted from
 * apps/reserve/.env, or the local stack under SUPABASE_LOCAL=true).
 * Read-only; prints PASS/FAIL only.
 *
 *   npm run verify:policies
 */
import pg from "pg";
import { get, guard, pgSsl } from "./_env.mjs";

guard(["DATABASE_URL"]);
const dsn = get("DATABASE_URL");

/** Helpers whose value cannot differ between the rows of one statement. */
const HELPERS = ["current_org_id", "current_staff_id", "has_permission", "is_admin", "auth.uid", "is_conversation_participant"];

/** Policies allowed a bare call, each with the reason it cannot be hoisted. */
const ALLOWED = {
  "conversation_participants.participants_read":
    "is_conversation_participant(conversation_id) is correlated on the row's own column; the table cannot select from itself in its own policy without recursing, which is why the helper exists",
  "conversations.conversations_read":
    "correlated on the row's own column; an uncorrelated `in (select …)` would read conversation_participants under its own policy and call the helper per row anyway",
  "messages.messages_read":
    "correlated on the row's own column; same reasoning as conversations_read",
  "messages.messages_send":
    "WITH CHECK on the one row being inserted: is_conversation_participant(conversation_id) is correlated by design; its current_staff_id() is wrapped",
};

/** RLS tables with no policy on purpose: reached by the service role only. */
const SERVICE_ROLE_ONLY = new Set(["campaign_unsubscribe_tokens", "cancellation_tokens", "stripe_events"]);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every bare helper call in an expression: pg prints a wrapped one as "( SELECT helper(...) AS …)". */
function bareCalls(expr) {
  const hits = [];
  if (!expr) return hits;
  for (const h of HELPERS) {
    const re = new RegExp(h.replace(".", "\\.") + "\\(", "g");
    let m;
    while ((m = re.exec(expr))) {
      const before = expr.slice(Math.max(0, m.index - 12), m.index);
      if (!/\(\s*select\s+$/i.test(before)) hits.push(h);
    }
  }
  return hits;
}

const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
await c.connect();
try {
  const { rows: policies } = await c.query(
    "select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname",
  );
  const { rows: tables } = await c.query(
    "select c.relname as table_name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1",
  );
  console.log(`\nverify-policies — ${policies.length} policies on ${tables.length} tables (${dsn.replace(/:[^:@/]+@/, ":***@")})\n`);

  // ── 1. no bare helper call outside the allowlist ─────────────────────
  const offenders = [];
  const matchedAllow = new Set();
  for (const p of policies) {
    const key = `${p.tablename}.${p.policyname}`;
    for (const [clause, expr] of [["USING", p.qual], ["WITH CHECK", p.with_check]]) {
      const bare = bareCalls(expr);
      if (!bare.length) continue;
      if (key in ALLOWED) {
        matchedAllow.add(key);
        // Only the correlated helper may be bare in an allowlisted policy.
        const other = bare.filter((h) => h !== "is_conversation_participant");
        if (other.length) offenders.push(`${key} ${clause}: ${other.join(", ")} (allowlisted only for is_conversation_participant)`);
        continue;
      }
      offenders.push(`${key} ${clause}: ${[...new Set(bare)].join(", ")}`);
    }
  }
  check(`every helper call in every policy is wrapped as (select …), outside the allowlist (${Object.keys(ALLOWED).length} entries)`, offenders.length === 0, `\n          ${offenders.join("\n          ")}`);

  // ── 2. the allowlist is not stale ─────────────────────────────────────
  const stale = Object.keys(ALLOWED).filter((k) => !matchedAllow.has(k));
  check("every allowlist entry still names a policy with a bare correlated call", stale.length === 0, stale.join(", "));

  // ── 3. every public table has RLS, and every RLS table has a policy or is service-role-only
  const noRls = tables.filter((t) => !t.rls).map((t) => t.table_name);
  check("every table in public has row-level security enabled", noRls.length === 0, noRls.join(", "));
  const withPolicies = new Set(policies.map((p) => p.tablename));
  const open = tables.filter((t) => t.rls && !withPolicies.has(t.table_name) && !SERVICE_ROLE_ONLY.has(t.table_name)).map((t) => t.table_name);
  check("every RLS table has at least one policy, or is on the service-role-only list", open.length === 0, open.join(", "));
  const staleServiceOnly = [...SERVICE_ROLE_ONLY].filter((t) => withPolicies.has(t) || !tables.some((x) => x.table_name === t));
  check("the service-role-only list names only tables that exist and have no policy", staleServiceOnly.length === 0, staleServiceOnly.join(", "));
} finally {
  await c.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
