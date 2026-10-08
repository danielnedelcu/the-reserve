/**
 * Load seed for the server-side tables benchmark (docs/design/server-tables-design.md,
 * decision 7). Puts 10,000 clients, 2,000 products and 50,000 transactions
 * (with their lines and payments, 3% of them refunds) into the seeded
 * organisation on the LOCAL stack — never anywhere else: it refuses to run
 * without SUPABASE_LOCAL=true and the localhost guard. Clients are tagged
 * referral_source = 'LOAD-SEED', products and staff are named 'LOAD-SEED …',
 * transactions carry note 'LOAD-SEED'; appointments carry notes
 * 'LOAD-SEED' (one completed hour per seeded service line, 50,000 over
 * the five providers, each with its appointment_services line, for the
 * schedule benchmark — docs/design/policy-sweep-design.md); `--clean`
 * removes them all.
 *
 * Ledger rows go through the DIRECT postgres connection, each batch in
 * one transaction with the ledger's triggers ACTIVE, so the seed is
 * balanced or it fails at commit; `--clean` is the one place
 * session_replication_role = replica is set (ledger-integrity-design.md).
 *
 *   npm run seed:tables            seed everything (clients: --count N; transactions: --transactions N)
 *   npm run seed:tables -- --clean remove them
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { get, guard, supabaseEnv, requireLocalStack } from "./_env.mjs";

requireLocalStack("the load seed");
guard(["NUXT_PUBLIC_SUPABASE_URL"]);
const { url, serviceKey } = supabaseEnv();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const TAG = "LOAD-SEED";

/** insert into <table> (cols) values (...),(...) returning id — one statement per batch. */
async function insertMany(db, table, cols, rows, returning = "id") {
  if (!rows.length) return [];
  const params = [];
  const tuples = rows.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(",")})`);
  const { rows: out } = await db.query(`insert into ${table} (${cols.join(",")}) values ${tuples.join(",")} returning ${returning}`, params);
  return out;
}

const org = await admin.from("organizations").select("id, name").order("created_at").limit(1).maybeSingle();
if (org.error || !org.data) {
  console.error("No organisation on the local stack (reset it from the migrations first).");
  process.exit(1);
}

if (process.argv.includes("--clean")) {
  // Straight SQL on the local database: 50,000 transactions and 100,000
  // lines are not a job for ids in a URL. The ledger first (its rows
  // reference clients and staff): payments and lines, then refunds, then
  // originals; then the seeded staff, clients and products.
  guard(["DATABASE_URL"]);
  const db = new pg.Client({ connectionString: get("DATABASE_URL") });
  await db.connect();
  const counts = {};
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica"); // the append-only block, skipped for cleanup only
    counts.payments = (await db.query("delete from payments p using transactions t where p.transaction_id = t.id and t.note = $1", [TAG])).rowCount;
    counts.items = (await db.query("delete from transaction_items i using transactions t where i.transaction_id = t.id and t.note = $1", [TAG])).rowCount;
    counts.refunds = (await db.query("delete from transactions where note = $1 and refunds_transaction_id is not null", [TAG])).rowCount;
    counts.transactions = (await db.query("delete from transactions where note = $1", [TAG])).rowCount;
    counts.appointments = (await db.query("delete from appointments where notes = $1", [TAG])).rowCount; // lines cascade
    counts.services = (await db.query("delete from services where name like $1", [`${TAG} %`])).rowCount;
    counts.staff = (await db.query("delete from staff where display_name like $1", [`${TAG} %`])).rowCount;
    counts.clients = (await db.query("delete from clients where referral_source = $1", [TAG])).rowCount;
    counts.products = (await db.query("delete from products where name like $1", [`${TAG} %`])).rowCount;
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    console.error(`clean failed: ${e.message}`);
    process.exit(1);
  } finally {
    await db.end();
  }
  console.log(`Removed ${counts.transactions} seeded transactions (${counts.refunds} refunds, ${counts.items} lines, ${counts.payments} payments), ${counts.appointments} appointments, ${counts.services} services, ${counts.staff} staff, ${counts.clients} clients and ${counts.products} products.`);
  process.exit(0);
}

const countArg = process.argv.indexOf("--count");
const COUNT = countArg > -1 ? Number(process.argv[countArg + 1]) : 10_000;

const FIRST = ["Maria", "Ben", "Ava", "Max", "Zoe", "Liam", "Noah", "Emma", "Olivia", "Sofia", "Lucas", "Mia", "Ethan", "Isla", "Leo", "Nora", "Jonah", "Priya", "Kenji", "Amara", "Diego", "Hana", "Omar", "Yara", "Felix", "Ines", "Mateo", "Rosa", "Theo", "Vera"];
const LAST = ["Alvarez", "Ng", "Patel", "Okafor", "Nakamura", "Schmidt", "Rossi", "Dubois", "Haddad", "Ivanova", "Kowalski", "Lindqvist", "Moreau", "Novak", "Oyelaran", "Petrov", "Quinn", "Reyes", "Santos", "Tanaka", "Ueda", "Varga", "Walsh", "Xu", "Yilmaz", "Zhang", "Brooks", "Carter", "Dawson", "Ellis"];
const pick = (list, i, j) => list[(i * 31 + j * 17) % list.length];

let inserted = 0;
for (let start = 0; start < COUNT; start += 1_000) {
  const rows = [];
  for (let i = start; i < Math.min(start + 1_000, COUNT); i++) {
    const first = pick(FIRST, i, 3);
    const last = pick(LAST, i, 7);
    rows.push({
      organization_id: org.data.id,
      first_name: first,
      last_name: `${last}${i % 50 === 0 ? "" : ""}`,
      email: i % 5 === 0 ? null : `${first}.${last}.${i}@load.test`.toLowerCase(),
      phone: i % 7 === 0 ? null : `(555) ${String(100 + (i % 900)).padStart(3, "0")}-${String(i % 10_000).padStart(4, "0")}`,
      active: i % 10 !== 0,
      no_show_count: i % 13 === 0 ? (i % 4) + 1 : 0,
      referral_source: TAG,
    });
  }
  const { error } = await admin.from("clients").insert(rows);
  if (error) {
    console.error(`insert failed at ${start}: ${error.message}`);
    process.exit(1);
  }
  inserted += rows.length;
  process.stdout.write(`\r${inserted} / ${COUNT}`);
}
console.log(`\nSeeded ${inserted} clients into "${org.data.name}" (tagged ${TAG}).`);

// Products: 2,000, names unique per organisation, with and without a cost,
// a spread of stock (out, low, plenty), a tenth inactive.
const GOODS = ["Lavender Lotion", "Rose Oil", "Sea Salt Scrub", "Eucalyptus Balm", "Mint Lip Care", "Chamomile Mist", "Jasmine Candle", "Argan Serum", "Shea Butter", "Green Tea Toner", "Bamboo Comb", "Silk Mask", "Vanilla Soak", "Citrus Scrub", "Clay Mask", "Hemp Lotion", "Cedar Soap", "Aloe Gel", "Oat Cleanser", "Honey Balm"];
const PRODUCT_COUNT = 2_000;
let made = 0;
for (let start = 0; start < PRODUCT_COUNT; start += 500) {
  const rows = [];
  for (let i = start; i < Math.min(start + 500, PRODUCT_COUNT); i++) {
    const good = GOODS[i % GOODS.length];
    rows.push({
      organization_id: org.data.id,
      name: `${TAG} ${good} ${i}`,
      description: i % 3 === 0 ? `${good}, 250 ml` : null,
      sku: `SKU-${String(i).padStart(5, "0")}`,
      price_cents: 500 + (i % 40) * 125,
      cost_cents: i % 5 === 0 ? null : Math.round((500 + (i % 40) * 125) * (0.3 + (i % 7) / 20)),
      stock_quantity: i % 11 === 0 ? 0 : i % 7 === 0 ? (i % 5) + 1 : 6 + (i % 90),
      taxable: i % 9 !== 0,
      active: i % 10 !== 0,
    });
  }
  const { error } = await admin.from("products").insert(rows);
  if (error) {
    console.error(`products insert failed at ${start}: ${error.message}`);
    process.exit(1);
  }
  made += rows.length;
}
console.log(`Seeded ${made} products (named "${TAG} …").`);

// Transactions: N over the last 365 days, each with 1–3 lines (a service
// attributed to one of five seeded providers, often a product, sometimes a
// tip and a discount), one payment, a tenth walk-ins, and 3% refunds
// issued one to twenty days after their original. Headers follow the
// checkout route's arithmetic.
const txArg = process.argv.indexOf("--transactions");
const TXN_COUNT = txArg > -1 ? Number(process.argv[txArg + 1]) : 50_000;
const location = await admin.from("locations").select("id").eq("organization_id", org.data.id).order("created_at").limit(1).single();
const clientIds = (await admin.from("clients").select("id").eq("referral_source", TAG).limit(2000)).data.map((c) => c.id);
const productNames = (await admin.from("products").select("name").like("name", `${TAG} %`).limit(200)).data.map((p) => p.name);
const providers = [];
for (let i = 0; i < 5; i++) {
  const { data: s } = await admin.from("staff").insert({ organization_id: org.data.id, display_name: `${TAG} Provider ${i + 1}`, email: `load-seed-provider-${i + 1}@load.test`, bookable: true, active: i !== 4 }).select("id").single();
  providers.push(s.id);
}
const cashier = providers[0];
const SERVICES = ["Swedish Massage", "Deep Tissue", "Signature Facial", "Hot Stone", "Body Scrub", "Express Facial"];
const METHODS = ["card_external", "cash", "stripe_card", "gift_card"];
const DAY = 86_400_000;
const start = Date.now() - 365 * DAY;
let txMade = 0;
const originals = []; // { id, at, items, total } for the refund pass
guard(["DATABASE_URL"]);
const ledgerDsn = get("DATABASE_URL");
const ledgerDb = new pg.Client({ connectionString: ledgerDsn });
await ledgerDb.connect();
const HEADER_COLS = ["organization_id", "location_id", "client_id", "refunds_transaction_id", "subtotal_cents", "discount_cents", "tax_cents", "tip_cents", "total_cents", "checked_out_by", "note", "created_at", "idempotency_key"];
const LINE_COLS = ["transaction_id", "kind", "name_snapshot", "quantity", "unit_price_cents", "taxable", "tax_cents", "total_cents", "staff_id"];
const PAY_COLS = ["transaction_id", "method", "amount_cents", "reference", "stripe_payment_intent_id"];
for (let b = 0; b < TXN_COUNT; b += 500) {
  const headers = [];
  const lineSets = [];
  for (let i = b; i < Math.min(b + 500, TXN_COUNT); i++) {
    const at = new Date(start + Math.floor((i / TXN_COUNT) * 365 * DAY) + (i % 97) * 600_000).toISOString();
    const prov = providers[i % providers.length];
    const items = [{ kind: "service", name: SERVICES[i % SERVICES.length], total_cents: 6000 + (i % 9) * 1500, tax_cents: 0, staff_id: prov }];
    if (i % 3 === 0) items.push({ kind: "product", name: productNames[i % productNames.length] ?? "Lotion", total_cents: 1500 + (i % 7) * 500, tax_cents: Math.round((1500 + (i % 7) * 500) * 0.08), staff_id: null });
    if (i % 4 === 0) items.push({ kind: "tip", name: "Tip", total_cents: 1000 + (i % 5) * 200, tax_cents: 0, staff_id: prov });
    if (i % 10 === 0) items.push({ kind: "discount", name: "Member discount", total_cents: -1000, tax_cents: 0, staff_id: null });
    const subtotal = items.filter((x) => ["service", "product"].includes(x.kind)).reduce((a, x) => a + x.total_cents, 0);
    const discount = -items.filter((x) => x.kind === "discount").reduce((a, x) => a + x.total_cents, 0);
    const tax = items.reduce((a, x) => a + x.tax_cents, 0);
    const tip = items.filter((x) => x.kind === "tip").reduce((a, x) => a + x.total_cents, 0);
    const total = subtotal - discount + tax + tip;
    headers.push({ organization_id: org.data.id, location_id: location.data.id, client_id: i % 10 === 0 ? null : clientIds[i % clientIds.length], subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, tip_cents: tip, total_cents: total, checked_out_by: cashier, note: TAG, created_at: at, idempotency_key: `seed:${randomUUID()}` });
    lineSets.push({ items, total, at, method: METHODS[i % METHODS.length], ref: i % 2 === 0 ? `ref-${String(i).padStart(8, "0")}` : null, refund: i % 33 === 0 });
  }
  let rows;
  try {
    await ledgerDb.query("begin");
    rows = await insertMany(ledgerDb, "transactions", HEADER_COLS, headers);
    const lines = [];
    const pays = [];
    rows.forEach((r, k) => {
      const set = lineSets[k];
      for (const x of set.items) lines.push({ transaction_id: r.id, kind: x.kind, name_snapshot: x.name, quantity: 1, unit_price_cents: x.total_cents, taxable: x.tax_cents > 0, tax_cents: x.tax_cents, total_cents: x.total_cents, staff_id: x.staff_id });
      const method = set.method === "gift_card" ? "cash" : set.method;
      pays.push({ transaction_id: r.id, method, amount_cents: set.total, reference: method === "stripe_card" ? `pi_${String(txMade + k).padStart(8, "0")}` : set.ref, stripe_payment_intent_id: method === "stripe_card" ? `pi_${String(txMade + k).padStart(8, "0")}` : null });
      if (set.refund) originals.push({ id: r.id, at: set.at, items: set.items, header: headers[k] });
    });
    await insertMany(ledgerDb, "transaction_items", LINE_COLS, lines);
    await insertMany(ledgerDb, "payments", PAY_COLS, pays);
    await ledgerDb.query("commit"); // the ledger's invariants are checked here
  } catch (e) {
    await ledgerDb.query("rollback").catch(() => {});
    console.error(`ledger batch at ${b} failed at commit: ${e.message}`);
    process.exit(1);
  }
  txMade += rows.length;
  process.stdout.write(`\rtransactions ${txMade} / ${TXN_COUNT}`);
}
// The refunds: negative mirrors, issued later.
for (let b = 0; b < originals.length; b += 500) {
  const chunk = originals.slice(b, b + 500);
  const headers = chunk.map((o, k) => ({ ...o.header, refunds_transaction_id: o.id, subtotal_cents: -o.header.subtotal_cents, discount_cents: -o.header.discount_cents, tax_cents: -o.header.tax_cents, tip_cents: -o.header.tip_cents, total_cents: -o.header.total_cents, created_at: new Date(Date.parse(o.at) + (1 + (k % 20)) * DAY).toISOString(), idempotency_key: `seed:refund:${o.id}` }));
  try {
    await ledgerDb.query("begin");
    const rows = await insertMany(ledgerDb, "transactions", HEADER_COLS, headers);
    const lines = [];
    const pays = [];
    rows.forEach((r, k) => {
      for (const x of chunk[k].items) lines.push({ transaction_id: r.id, kind: x.kind, name_snapshot: `Refund — ${x.name}`, quantity: 1, unit_price_cents: -x.total_cents, taxable: x.tax_cents > 0, tax_cents: -x.tax_cents, total_cents: -x.total_cents, staff_id: x.staff_id });
      pays.push({ transaction_id: r.id, method: "cash", amount_cents: -chunk[k].header.total_cents, reference: null, stripe_payment_intent_id: null });
    });
    await insertMany(ledgerDb, "transaction_items", LINE_COLS, lines);
    await insertMany(ledgerDb, "payments", PAY_COLS, pays);
    await ledgerDb.query("commit");
  } catch (e) {
    await ledgerDb.query("rollback").catch(() => {});
    console.error(`refund batch failed at commit: ${e.message}`);
    process.exit(1);
  }
}
console.log(`\nSeeded ${txMade} transactions and ${originals.length} refunds (note "${TAG}"). Remove with --clean.`);

// Appointments: one completed hour per transaction, in the five providers'
// lanes back to back (the no-double-booking exclusion holds because each
// provider's hours are consecutive), with one appointment_services line
// each — the schedule's shape, for the policy-sweep benchmark on
// appointments_read's own-versus-any branch and appointment_services.
const { rows: svc } = await ledgerDb.query("insert into services (organization_id, name, duration_minutes, price_cents, requires_intake) values ($1, $2, 60, 10000, false) returning id", [org.data.id, `${TAG} Service`]);
const SERVICE = svc[0].id;
const APPT_COLS = ["organization_id", "location_id", "client_id", "staff_id", "blocked_from", "blocked_until", "starts_at", "ends_at", "status", "booked_by", "notes"];
const APPT_LINE_COLS = ["appointment_id", "service_id", "name_snapshot", "price_cents", "duration_min"];
const HOUR = 3_600_000;
let apptMade = 0;
for (let b = 0; b < TXN_COUNT; b += 500) {
  const headers = [];
  for (let i = b; i < Math.min(b + 500, TXN_COUNT); i++) {
    const prov = providers[i % providers.length];
    const slot = Math.floor(i / providers.length); // this provider's n-th hour
    const at = new Date(start + slot * HOUR);
    const end = new Date(at.getTime() + HOUR);
    headers.push({ organization_id: org.data.id, location_id: location.data.id, client_id: clientIds[i % clientIds.length], staff_id: prov, blocked_from: at.toISOString(), blocked_until: end.toISOString(), starts_at: at.toISOString(), ends_at: end.toISOString(), status: i % 29 === 0 ? "cancelled" : "completed", booked_by: cashier, notes: TAG });
  }
  try {
    await ledgerDb.query("begin");
    const rows = await insertMany(ledgerDb, "appointments", APPT_COLS, headers);
    await insertMany(ledgerDb, "appointment_services", APPT_LINE_COLS, rows.map((r) => ({ appointment_id: r.id, service_id: SERVICE, name_snapshot: SERVICES[apptMade % SERVICES.length], price_cents: 10_000, duration_min: 60 })));
    await ledgerDb.query("commit");
  } catch (e) {
    await ledgerDb.query("rollback").catch(() => {});
    console.error(`appointments batch at ${b} failed: ${e.message}`);
    process.exit(1);
  }
  apptMade += rows_or(headers.length);
  process.stdout.write(`\rappointments ${apptMade} / ${TXN_COUNT}`);
}
function rows_or(n) { return n; }
await ledgerDb.end();
console.log(`\nSeeded ${apptMade} appointments with one service line each (notes "${TAG}").`);
