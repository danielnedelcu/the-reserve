/**
 * Performance check for the server-side table functions — clients_page
 * and products_page (docs/design/server-tables-design.md, decision 7), on
 * the LOCAL stack only, after `npm run seed:tables`. For each case it
 * measures, as a real staff session's claims:
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
 * Budget (the design, decided 2026-10-06 per WINDOW): a case whose range
 * is a month or less — and every clients and products case — must run at
 * p50 ≤ 50ms, max ≤ 200ms; a year-wide range at p50 ≤ 400ms, max ≤ 800ms,
 * because a year sums every line of the ledger on each call and no policy
 * shape brings that under 50ms (the design's [AS-BUILT] records the
 * alternatives measured and rejected). A searched case must not
 * sequentially scan the table carrying the searched columns (clients,
 * products); a scan of transactions over a window that holds every row is
 * the planner's right choice and is reported, not failed. Exit 1 when a
 * case is over its budget.
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
const BUDGET = { month: { p50: 50, max: 200 }, year: { p50: 400, max: 800 } };
const budgetFor = (args) => {
  if (!args.p_from || !args.p_to) return BUDGET.month;
  const days = (Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000;
  return days > 45 ? BUDGET.year : BUDGET.month;
};

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const run = randomBytes(4).toString("hex");

const org = await admin.from("organizations").select("id").order("created_at").limit(1).single();
const seeded = await admin.from("clients").select("id", { count: "exact", head: true }).eq("organization_id", org.data.id);
const seededProducts = await admin.from("products").select("id", { count: "exact", head: true }).eq("organization_id", org.data.id);
const seededTxns = await admin.from("transactions").select("id", { count: "exact", head: true }).eq("organization_id", org.data.id);
console.log(`clients in the organisation: ${seeded.count}; products: ${seededProducts.count}; transactions: ${seededTxns.count} (run ${run})`);
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

const DAY = 86_400_000;
const MONTH = { p_from: new Date(Date.now() - 30 * DAY).toISOString(), p_to: new Date().toISOString() };
const YEAR = { p_from: new Date(Date.now() - 365 * DAY).toISOString(), p_to: new Date().toISOString() };
const PROVIDER = (await admin.from("staff").select("id").like("display_name", "LOAD-SEED Provider %").limit(1).maybeSingle()).data?.id ?? null;
const CASES = [
  { fn: "clients_page", name: "default page (no search, name asc)", args: {} },
  { fn: "clients_page", name: "name sort, descending", args: { p_sort: "name", p_desc: true } },
  { fn: "clients_page", name: "sort by no-shows, descending", args: { p_sort: "no_shows", p_desc: true } },
  { fn: "clients_page", name: "sort by contact", args: { p_sort: "contact" } },
  { fn: "clients_page", name: "search a common first name: 'maria'", args: { p_q: "maria" } },
  { fn: "clients_page", name: "search two words: 'maria alvarez'", args: { p_q: "maria alvarez" } },
  { fn: "clients_page", name: "search an email fragment: 'patel.4'", args: { p_q: "patel.4" } },
  { fn: "clients_page", name: "search phone digits: '555 0123'", args: { p_q: "555 0123" } },
  { fn: "clients_page", name: "search a rare string: 'zzzz'", args: { p_q: "zzzz" } },
  { fn: "clients_page", name: "all clients, including inactive", args: { p_active: "all" } },
  { fn: "clients_page", name: "page 100 of the default order", args: { p_page: 100 } },
  { fn: "clients_page", name: "picker: 'ben', 8 rows", args: { p_q: "ben", p_page_size: 8 } },
  { fn: "products_page", name: "default page (name asc)", args: {} },
  { fn: "products_page", name: "name sort, descending", args: { p_sort: "name", p_desc: true } },
  { fn: "products_page", name: "sort by price, descending", args: { p_sort: "price", p_desc: true } },
  { fn: "products_page", name: "sort by stock", args: { p_sort: "stock" } },
  { fn: "products_page", name: "sort by margin, descending (manager)", args: { p_sort: "margin", p_desc: true } },
  { fn: "products_page", name: "search a common word: 'lotion'", args: { p_q: "lotion" } },
  { fn: "products_page", name: "search a SKU: 'sku-0042'", args: { p_q: "sku-0042" } },
  { fn: "products_page", name: "low stock", args: { p_stock: "low" } },
  { fn: "products_page", name: "out of stock, including inactive", args: { p_stock: "out", p_active: "all" } },
  { fn: "transactions_page", name: "this month (default), newest first", args: { ...MONTH } },
  { fn: "transactions_page", name: "this month, cards only (p_page_size 1)", args: { ...MONTH, p_page_size: 1 } },
  { fn: "transactions_page", name: "the year", args: { ...YEAR } },
  { fn: "transactions_page", name: "the year, cards only (p_page_size 1)", args: { ...YEAR, p_page_size: 1 } },
  { fn: "transactions_page", name: "month, sort by client", args: { ...MONTH, p_sort: "client", p_desc: false } },
  { fn: "transactions_page", name: "month, sort by total", args: { ...MONTH, p_sort: "total" } },
  { fn: "transactions_page", name: "year, search an item: 'facial'", args: { ...YEAR, p_q: "facial" } },
  { fn: "transactions_page", name: "year, search an amount: '75'", args: { ...YEAR, p_q: "75" } },
  { fn: "transactions_page", name: "year, search a reference: 'ref-00004'", args: { ...YEAR, p_q: "ref-00004" } },
  { fn: "transactions_page", name: "year, refunds only", args: { ...YEAR, p_kind: "refund" } },
  { fn: "transactions_page", name: "year, cash only", args: { ...YEAR, p_method: "cash" } },
  { fn: "transactions_page", name: "year, one provider", args: { ...YEAR, p_staff_id: PROVIDER } },
];

const pgc = new pg.Client({ connectionString: DATABASE_URL });
await pgc.connect();
// Fresh statistics after a seed (production's autovacuum does this on its
// own), and the ledger's tables for the index deltas.
await pgc.query("analyze clients; analyze products; analyze transactions; analyze transaction_items; analyze payments");
const TABLES_OF = { clients_page: ["clients"], products_page: ["products"], transactions_page: ["transactions", "transaction_items", "payments"] };
const stats = async (tables) => {
  const idx = await pgc.query(`select indexrelname, idx_scan from pg_stat_user_indexes where relname = any($1)`, [tables]);
  const seq = await pgc.query(`select relname, seq_scan from pg_stat_user_tables where relname = any($1)`, [tables]);
  return { idx: Object.fromEntries(idx.rows.map((r) => [r.indexrelname, Number(r.idx_scan)])), seq: Object.fromEntries(seq.rows.map((r) => [r.relname, Number(r.seq_scan)])) };
};
const callSql = (fn, args) => {
  const keys = ["p_from", "p_to", "p_q", "p_active", "p_stock", "p_kind", "p_method", "p_staff_id", "p_sort", "p_desc", "p_page", "p_page_size"];
  const present = keys.filter((k) => args[k] !== undefined);
  return { text: `select ${fn}(${present.map((k, i) => `${k} => $${i + 1}`).join(", ")})`, values: present.map((k) => args[k]) };
};

let overBudget = false;
const results = [];
try {
  for (const c of CASES) {
    const tables = TABLES_OF[c.fn];
    const times = [];
    // One warm-up run (a cold cache after a seed is not what a page sees), then the measured runs.
    for (let i = -1; i < RUNS; i++) {
      if (i === 0) var before = await stats(tables);
      await pgc.query("begin");
      await pgc.query("set local role authenticated");
      await pgc.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const { text, values } = callSql(c.fn, c.args);
      const t0 = process.hrtime.bigint();
      await pgc.query(text, values);
      if (i >= 0) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await pgc.query("rollback");
    }
    const after = await stats(tables);
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    const used = Object.entries(after.idx).filter(([k, v]) => v > (before.idx[k] ?? 0)).map(([k, v]) => `${k}×${v - (before.idx[k] ?? 0)}`);
    const seqScans = Object.entries(after.seq).map(([k, v]) => [k, v - (before.seq[k] ?? 0)]).filter(([, d]) => d > 0).map(([k, d]) => `${k}×${d}`);
    // The API round trip, once, as the session.
    const a0 = Date.now();
    const api = await session.rpc(c.fn, c.args);
    const apiMs = Date.now() - a0;
    const total = api.data?.total;
    const budget = budgetFor(c.args);
    const searchedTableScanned = c.args.p_q && seqScans.some((s) => !s.startsWith("transactions×"));
    const over = p50 > budget.p50 || max > budget.max || searchedTableScanned;
    if (c.fn === "transactions_page" && PROVIDER === null && c.args.p_staff_id === null) { console.log(`skip  ${c.fn}: ${c.name} (no seeded provider)`); continue; }
    overBudget ||= over;
    results.push({ name: c.name, p50, max, apiMs, total, used, seqScans, over });
    console.log(`${over ? "OVER " : "ok   "} ${c.fn}: ${c.name}  [${budget === BUDGET.year ? "year" : "month"} budget]\n       db p50 ${p50.toFixed(1)}ms  max ${max.toFixed(1)}ms  api ${apiMs}ms  total ${total}  seq_scan ${seqScans.join(", ") || "none"}  idx: ${used.join(", ") || "none"}`);
  }
} finally {
  await pgc.end();
  await admin.from("staff_roles").delete().eq("staff_id", staff.data.id);
  await admin.from("staff").delete().eq("id", staff.data.id);
  await admin.auth.admin.deleteUser(made.user.id);
  void signed;
}

console.log(`\nbudgets: month p50 ≤ ${BUDGET.month.p50}ms, max ≤ ${BUDGET.month.max}ms; year p50 ≤ ${BUDGET.year.p50}ms, max ≤ ${BUDGET.year.max}ms; no sequential scan of a searched table`);
if (overBudget) {
  console.log("OVER BUDGET");
  process.exit(1);
}
