/**
 * Performance check for the server-side table functions
 * (docs/design/server-tables-design.md, decision 7), on the LOCAL stack
 * only, after `npm run seed:tables`. For each case it measures, as a real
 * staff session's claims:
 *
 *   - database time: median and max over N runs of the function itself,
 *     through a direct connection with `set local role authenticated` and
 *     the session's JWT claims — what RLS and the function see in
 *     production, without the HTTP hop;
 *   - index use: the change in pg_stat_user_indexes.idx_scan for the
 *     clients indexes and in pg_stat_user_tables.seq_scan for clients
 *     across the runs (auto_explain is not available on Supabase, so the
 *     statistics are the evidence);
 *   - the API round trip: supabase-js rpc() as the signed-in session.
 *
 * Budget (the design): p50 ≤ 50ms, max ≤ 200ms, and no sequential scan of
 * clients for a searched case. Exit 1 when a case is over budget.
 *
 *   npm run bench:tables            (default 20 runs a case; --runs N)
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { LOCAL_MODE, get, guard, supabaseEnv } from "./_env.mjs";

if (!LOCAL_MODE) {
  console.error("SAFETY: the benchmark runs on the LOCAL stack only. Set SUPABASE_LOCAL=true with the stack's env exported.");
  process.exit(1);
}
guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const { url, anonKey, serviceKey } = supabaseEnv();
const DATABASE_URL = get("DATABASE_URL");
const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg > -1 ? Number(process.argv[runsArg + 1]) : 20;
const BUDGET = { p50: 50, max: 200 };

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const run = randomBytes(4).toString("hex");

const org = await admin.from("organizations").select("id").order("created_at").limit(1).single();
const seeded = await admin.from("clients").select("id", { count: "exact", head: true }).eq("organization_id", org.data.id);
console.log(`clients in the organisation: ${seeded.count} (run ${run})`);
if ((seeded.count ?? 0) < 1_000) console.log("  note  fewer than 1,000 clients — run `npm run seed:tables` first for a meaningful number");

// A staff session holding clients.view, through the seeded admin role.
const adminRole = await admin.from("roles").select("id").eq("organization_id", org.data.id).eq("name", "admin").single();
const email = `bench-tbl-${run}@verify.test`;
const password = `bt-${randomBytes(12).toString("hex")}`;
const { data: made } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const staff = await admin.from("staff").insert({ organization_id: org.data.id, user_id: made.user.id, display_name: `BENCH-TBL ${run}`, email, bookable: false, active: true }).select("id").single();
await admin.from("staff_roles").insert({ staff_id: staff.data.id, role_id: adminRole.data.id });
const session = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const signed = await session.auth.signInWithPassword({ email, password });
const claims = { sub: made.user.id, role: "authenticated", aud: "authenticated" };

const CASES = [
  { name: "default page (no search, name asc)", args: {} },
  { name: "name sort, descending", args: { p_sort: "name", p_desc: true } },
  { name: "sort by no-shows, descending", args: { p_sort: "no_shows", p_desc: true } },
  { name: "sort by contact", args: { p_sort: "contact" } },
  { name: "search a common first name: 'maria'", args: { p_q: "maria" } },
  { name: "search two words: 'maria alvarez'", args: { p_q: "maria alvarez" } },
  { name: "search an email fragment: 'patel.4'", args: { p_q: "patel.4" } },
  { name: "search phone digits: '555 0123'", args: { p_q: "555 0123" } },
  { name: "search a rare string: 'zzzz'", args: { p_q: "zzzz" } },
  { name: "all clients, including inactive", args: { p_active: "all" } },
  { name: "page 100 of the default order", args: { p_page: 100 } },
  { name: "picker: 'ben', 8 rows", args: { p_q: "ben", p_page_size: 8 } },
];

const pgc = new pg.Client({ connectionString: DATABASE_URL });
await pgc.connect();
const stats = async () => {
  const idx = await pgc.query(`select indexrelname, idx_scan from pg_stat_user_indexes where relname = 'clients'`);
  const seq = await pgc.query(`select seq_scan from pg_stat_user_tables where relname = 'clients'`);
  return { idx: Object.fromEntries(idx.rows.map((r) => [r.indexrelname, Number(r.idx_scan)])), seq: Number(seq.rows[0]?.seq_scan ?? 0) };
};
const callSql = (args) => {
  const keys = ["p_q", "p_active", "p_sort", "p_desc", "p_page", "p_page_size"];
  const present = keys.filter((k) => args[k] !== undefined);
  return { text: `select clients_page(${present.map((k, i) => `${k} => $${i + 1}`).join(", ")})`, values: present.map((k) => args[k]) };
};

let overBudget = false;
const results = [];
try {
  for (const c of CASES) {
    const before = await stats();
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      await pgc.query("begin");
      await pgc.query("set local role authenticated");
      await pgc.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const { text, values } = callSql(c.args);
      const t0 = process.hrtime.bigint();
      await pgc.query(text, values);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await pgc.query("rollback");
    }
    const after = await stats();
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    const used = Object.entries(after.idx).filter(([k, v]) => v > (before.idx[k] ?? 0)).map(([k, v]) => `${k}×${v - (before.idx[k] ?? 0)}`);
    const seqScans = after.seq - before.seq;
    // The API round trip, once, as the session.
    const a0 = Date.now();
    const api = await session.rpc("clients_page", c.args);
    const apiMs = Date.now() - a0;
    const total = api.data?.total;
    const over = p50 > BUDGET.p50 || max > BUDGET.max || (c.args.p_q && seqScans > 0);
    overBudget ||= over;
    results.push({ name: c.name, p50, max, apiMs, total, used, seqScans, over });
    console.log(`${over ? "OVER " : "ok   "} ${c.name}\n       db p50 ${p50.toFixed(1)}ms  max ${max.toFixed(1)}ms  api ${apiMs}ms  total ${total}  seq_scan +${seqScans}  idx: ${used.join(", ") || "none"}`);
  }
} finally {
  await pgc.end();
  await admin.from("staff_roles").delete().eq("staff_id", staff.data.id);
  await admin.from("staff").delete().eq("id", staff.data.id);
  await admin.auth.admin.deleteUser(made.user.id);
  void signed;
}

console.log(`\nbudget: p50 ≤ ${BUDGET.p50}ms, max ≤ ${BUDGET.max}ms, no sequential scan on a searched case`);
if (overBudget) {
  console.log("OVER BUDGET");
  process.exit(1);
}
