/**
 * verify-presets — Ask's presets: they pair with their chips, they run as
 * ask_readonly under the asking admin's claims, and their MONEY AGREES
 * with transactions_page (docs/design/server-tables-design.md decision 2;
 * docs/design/ask-the-reserve-design.md, "Revenue: one definition").
 *
 * Every stack (hosted from apps/reserve/.env, or the local stack under
 * SUPABASE_LOCAL=true with ASK_READONLY_PASSWORD):
 *   (a) RLS resolves under injected claims;
 *   (b) every chip pairs with a PRESET_SQL query and vice versa;
 *   (c) every preset executes.
 *
 * LOCAL STACK ONLY (it writes ledger rows): a ledger fixture — a sale
 * with a discount and a tip, a gift-card sale, a late-cancellation fee, a
 * refund, a sale at 11:30 PM local on the last day of LAST month and one
 * at 12:30 AM on the first day of THIS month — and then, for each money
 * preset, its figures equal transactions_page's totals for the same
 * window; the month-edge sale counts in its own month; the gift-card
 * preset's first row equals gift_card_liability(); an anon session cannot
 * select from either view; a second organisation's lines never appear in
 * the first's view; a deactivated location's revenue still appears.
 * Fixtures are written through the direct postgres connection in one
 * transaction each with the ledger's triggers ACTIVE, and removed with
 * session_replication_role = replica, as verify-tables does.
 *
 *   npm run verify:presets
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_MODE, get, guard, pgSsl, supabaseEnv } from "./_env.mjs";
import { scrubTestStaff } from "./_cleanup.mjs";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PRESET_SQL } = await import(`${PROJECT}/apps/reserve/server/utils/askPresets.ts`);
const { ROUTE_PRESETS, ORG_PRESETS } = await import(`${PROJECT}/apps/reserve/shared/ask/presets.ts`);
// zone.ts has no imports, so Node's type stripping loads it; period.ts
// imports "./zone" without an extension, which Node cannot resolve, so the
// month arithmetic it would provide is done on keys here.
const { localToUtc, localDateKey } = await import(`${PROJECT}/apps/reserve/shared/time/zone.ts`);
const pad = (n) => String(n).padStart(2, "0");
const monthKey = (y, m) => `${y}-${pad(m)}-01`;
/** The month window [from, to) in a zone around a day key, as keys and instants. */
function monthOf(dayKey, zone, offsetMonths = 0) {
  const [y, m] = dayKey.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + offsetMonths, 1));
  const fromKey = monthKey(at.getUTCFullYear(), at.getUTCMonth() + 1);
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const nextKey = monthKey(next.getUTCFullYear(), next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 0));
  const toKey = `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
  return { fromKey, toKey, from: localToUtc(fromKey, "00:00", zone), to: localToUtc(nextKey, "00:00", zone) };
}

guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const { url, anonKey, serviceKey } = supabaseEnv();
const dbDsn = get("DATABASE_URL");

// The ask_readonly connection: on the local stack from the throwaway
// password the CI job (or the developer) set; hosted from ASK_DATABASE_URL.
let askDsn;
if (LOCAL_MODE) {
  const password = process.env.ASK_READONLY_PASSWORD || "";
  if (!password) {
    console.error("SAFETY: SUPABASE_LOCAL is set but ASK_READONLY_PASSWORD is not — set the role's password on the local stack first.");
    process.exit(1);
  }
  const local = new URL(dbDsn);
  askDsn = `postgresql://ask_readonly:${encodeURIComponent(password)}@${local.hostname}:${local.port || 5432}${local.pathname || "/postgres"}`;
} else {
  askDsn = get("ASK_DATABASE_URL");
  if (!askDsn?.startsWith("postgres")) {
    console.error("ASK_DATABASE_URL must be a full DSN for the hosted run.");
    process.exit(1);
  }
}

const run = randomBytes(4).toString("hex");
const TAG = `VERIFY-PRESETS-${run}`;
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
async function must(p, what) {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

/** One preset (or any SELECT) the way the route runs it: as ask_readonly, read-only, with the asking user's claims. */
async function runAsk(sql, userId) {
  const c = new pg.Client({ connectionString: askDsn, ssl: pgSsl(askDsn) });
  await c.connect();
  try {
    await c.query("begin read only");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const r = await c.query(`select * from (${sql}) as generated limit 501`);
    await c.query("commit");
    // int8 arrives as text; the route coerces it the same way.
    const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && /^-?\d+$/.test(v) && k.endsWith("_cents") ? Number(v) : v])));
    return { ok: true, rows, columns: r.fields.map((f) => f.name) };
  } catch (e) {
    return { ok: false, err: e.message.split("\n")[0] };
  } finally {
    await c.end().catch(() => {});
  }
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const made = { users: [], staff: [], roleRows: [], roles: [], clients: [], products: [], giftCards: [], transactions: [], locations: [], orgs: [] };
let db = null; // the direct connection, local only
let locationRestore = null;

async function roleWith(orgId, name, keys) {
  const role = await must(admin.from("roles").insert({ organization_id: orgId, name: `${TAG} ${name}`, is_system: false }).select("id").single(), `role ${name}`);
  made.roles.push(role.id);
  for (const key of keys) await must(admin.from("role_permissions").insert({ role_id: role.id, permission_key: key }), `role_permissions ${name}`);
  return role.id;
}
async function staffMember(orgId, label, roleId, { bookable = false } = {}) {
  const email = `verify-presets-${label}-${run}@verify.test`;
  const password = `vp-${randomBytes(12).toString("hex")}`;
  const { user } = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), `createUser ${label}`);
  made.users.push(user.id);
  const row = await must(admin.from("staff").insert({ organization_id: orgId, user_id: user.id, display_name: `${TAG} ${label}`, email, bookable, active: true }).select("id").single(), `staff ${label}`);
  made.staff.push(row.id);
  if (roleId) {
    await must(admin.from("staff_roles").insert({ staff_id: row.id, role_id: roleId }), `staff_roles ${label}`);
    made.roleRows.push({ staff_id: row.id, role_id: roleId });
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(client.auth.signInWithPassword({ email, password }), `signIn ${label}`);
  return { id: row.id, userId: user.id, client };
}
const ASK_KEYS = ["ask.query", "transactions.view", "financials.view_summary", "gift_cards.view", "clients.view", "products.view", "staff.view", "appointments.view.any"];

/** A fixture transaction through the direct connection, one commit, triggers active. */
async function txn(orgId, locationId, cashierId, { clientId = null, at, items, payment, note, refunds = null }) {
  const subtotal = items.filter((i) => ["service", "product", "gift_card", "late_cancellation_fee"].includes(i.kind)).reduce((a, i) => a + i.total_cents, 0);
  const discount = -items.filter((i) => i.kind === "discount").reduce((a, i) => a + i.total_cents, 0);
  const tax = items.reduce((a, i) => a + (i.tax_cents ?? 0), 0);
  const tip = items.filter((i) => i.kind === "tip").reduce((a, i) => a + i.total_cents, 0);
  const total = subtotal - discount + tax + tip;
  let id;
  try {
    await db.query("begin");
    const { rows } = await db.query(
      `insert into transactions (organization_id, location_id, client_id, refunds_transaction_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, checked_out_by, note, created_at, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [orgId, locationId, clientId, refunds, subtotal, discount, tax, tip, total, cashierId, note, at.toISOString(), `fixture:${run}:${randomBytes(6).toString("hex")}`],
    );
    id = rows[0].id;
    for (const i of items) {
      await db.query(
        `insert into transaction_items (transaction_id, kind, name_snapshot, quantity, unit_price_cents, taxable, tax_cents, total_cents, staff_id, product_id, gift_card_id, discount_reason)
         values ($1,$2,$3,1,$4,$5,$6,$4,$7,$8,$9,$10)`,
        [id, i.kind, i.name, i.total_cents, (i.tax_cents ?? 0) > 0, i.tax_cents ?? 0, i.staff_id ?? null, i.product_id ?? null, i.gift_card_id ?? null, i.kind === "discount" ? "fixture" : null],
      );
    }
    if (total !== 0) {
      await db.query(`insert into payments (transaction_id, method, amount_cents, reference, stripe_payment_intent_id) values ($1,$2,$3,$4,$5)`,
        [id, payment.method, total, payment.reference ?? null, payment.method === "stripe_card" ? payment.reference : null]);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw new Error(`fixture ${note}: ${e.message}`);
  }
  made.transactions.push(id);
  return { id, total, subtotal, discount, tax, tip };
}
async function refundOf(orig, orgId, locationId, cashierId, at) {
  const { rows: lines } = await db.query("select * from transaction_items where transaction_id = $1 order by id", [orig.id]);
  const { rows: pays } = await db.query("select * from payments where transaction_id = $1", [orig.id]);
  const { rows: hdr } = await db.query("select * from transactions where id = $1", [orig.id]);
  const h = hdr[0];
  let id;
  try {
    await db.query("begin");
    const { rows } = await db.query(
      `insert into transactions (organization_id, location_id, client_id, appointment_id, refunds_transaction_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, checked_out_by, note, created_at, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [orgId, locationId, h.client_id, h.appointment_id, orig.id, -h.subtotal_cents, -h.discount_cents, -h.tax_cents, -h.tip_cents, -h.total_cents, cashierId, `${TAG} refund`, at.toISOString(), `refund:${orig.id}`],
    );
    id = rows[0].id;
    for (const l of lines) {
      await db.query(
        `insert into transaction_items (transaction_id, kind, name_snapshot, quantity, unit_price_cents, taxable, tax_cents, total_cents, staff_id, product_id, gift_card_id, discount_reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, l.kind, `Refund — ${l.name_snapshot}`, l.quantity, -l.unit_price_cents, l.taxable, -l.tax_cents, -l.total_cents, l.staff_id, l.product_id, l.gift_card_id, l.discount_reason],
      );
    }
    for (const p of pays) {
      await db.query(`insert into payments (transaction_id, method, amount_cents, reference, stripe_payment_intent_id, gift_card_id) values ($1,$2,$3,$4,$5,$6)`,
        [id, p.method, -p.amount_cents, p.reference ? `refund: ${p.reference}` : null, p.stripe_payment_intent_id, p.gift_card_id]);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw new Error(`refund fixture: ${e.message}`);
  }
  made.transactions.push(id);
  return { id };
}
const totalsOf = async (session, from, to, extra = {}) => {
  const { data, error } = await session.client.rpc("transactions_page", { p_from: from.toISOString(), p_to: to.toISOString(), p_page_size: 1, ...extra });
  if (error) throw new Error(`transactions_page: ${error.message}`);
  return data;
};
const same = (a, b, keys) => keys.every((k) => Number(a?.[k] ?? 0) === Number(b?.[k] ?? 0));
const describe = (a, b, keys) => keys.map((k) => `${k}: ${a?.[k]} vs ${b?.[k]}`).join(", ");

async function main() {
  console.log(`\nverify-presets (${TAG}) — ${url}${LOCAL_MODE ? " (local: ledger agreement cases run)" : " (hosted: read-only cases only)"}\n`);

  // ---- the asking admin ------------------------------------------------
  let asker; // { userId, client?, id? }
  let ORG;
  if (LOCAL_MODE) {
    const org = await must(admin.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
    ORG = org.id;
    const role = await roleWith(ORG, "asker", ASK_KEYS);
    asker = await staffMember(ORG, "asker", role);
  } else {
    const priv = new pg.Client({ connectionString: dbDsn, ssl: pgSsl(dbDsn) });
    await priv.connect();
    const who = await priv.query(`select s.user_id, s.organization_id from staff s join staff_roles sr on sr.staff_id = s.id join role_permissions rp on rp.role_id = sr.role_id where rp.permission_key = 'ask.query' and s.active and s.user_id is not null limit 1`);
    await priv.end();
    if (!who.rows.length) throw new Error("no active staff member holds ask.query on this stack");
    asker = { userId: who.rows[0].user_id };
    ORG = who.rows[0].organization_id;
    console.log("using an ask.query holder's user_id (value not printed)");
  }

  // ---- (a) RLS resolves under claims ----------------------------------
  console.log("RLS under injected claims");
  const ident = await runAsk("select (current_org_id() is not null) as org_resolves, (current_staff_id() is not null) as staff_resolves", asker.userId);
  check("current_org_id() and current_staff_id() resolve for the asking admin", ident.ok && ident.rows[0]?.org_resolves === true && ident.rows[0]?.staff_resolves === true, ident.err ?? JSON.stringify(ident.rows?.[0]));
  const bogus = await runAsk("select count(*)::int as n from clients", "00000000-0000-0000-0000-000000000000");
  check("a bogus sub sees no clients (RLS yields nothing, never an error)", bogus.ok && Number(bogus.rows[0]?.n) === 0, bogus.err ?? `n=${bogus.rows?.[0]?.n}`);

  // ---- (b) chips <-> SQL pairing ---------------------------------------
  console.log("\npreset id pairing (chips <-> PRESET_SQL)");
  const chipIds = new Set([...ROUTE_PRESETS.flatMap((e) => e.presets.map((p) => p.id)), ...ORG_PRESETS.map((p) => p.id)]);
  const sqlIds = new Set(Object.keys(PRESET_SQL));
  const chipsWithoutSql = [...chipIds].filter((id) => !sqlIds.has(id));
  const sqlWithoutChips = [...sqlIds].filter((id) => !chipIds.has(id));
  check(`every chip has a PRESET_SQL query (${chipIds.size} chips)`, chipsWithoutSql.length === 0, chipsWithoutSql.join(", "));
  check("every PRESET_SQL query is reachable from a chip", sqlWithoutChips.length === 0, sqlWithoutChips.join(", "));

  // ---- (c) every preset executes ---------------------------------------
  console.log("\nevery preset executes as ask_readonly under the admin's claims");
  const results = {};
  for (const id of Object.keys(PRESET_SQL)) {
    const r = await runAsk(PRESET_SQL[id], asker.userId);
    results[id] = r;
    check(`${id} runs${r.ok ? ` (${r.rows.length} row(s), ${r.columns.length} col(s))` : ""}`, r.ok, r.err);
  }
  const moneyPresets = Object.keys(PRESET_SQL).filter((id) => results[id].ok && results[id].columns.some((c) => c.endsWith("_cents")));
  check("every money column is named _cents, and no money preset returns a bare 'spend' or 'total' column", moneyPresets.every((id) => !results[id].columns.some((c) => /^(spend|total|amount|revenue)$/.test(c))));

  if (!LOCAL_MODE) return;

  // ---- LOCAL: the ledger fixture ---------------------------------------
  console.log("\nthe ledger fixture (local stack; direct connection, one commit each, triggers active)");
  db = new pg.Client({ connectionString: dbDsn, ssl: pgSsl(dbDsn) });
  await db.connect();
  const loc = await must(admin.from("locations").select("id, timezone, active").eq("organization_id", ORG).order("created_at").order("id").limit(1).single(), "seeded location");
  locationRestore = { id: loc.id, timezone: loc.timezone, active: loc.active };
  const ZONE = "America/New_York"; // not the runner's zone, and west of UTC: 11:30 PM local is the next UTC day
  await must(admin.from("locations").update({ timezone: ZONE, active: true }).eq("id", loc.id), "location zone");
  const LOC = loc.id;
  const provider = await staffMember(ORG, "provider", null, { bookable: true });
  const noor = await must(admin.from("clients").insert({ organization_id: ORG, first_name: "Noor", last_name: `Presets-${run}`, referral_source: TAG }).select("id").single(), "client");
  made.clients.push(noor.id);
  const lotion = await must(admin.from("products").insert({ organization_id: ORG, name: `${TAG} Lotion`, sku: `VP-${run}`, price_cents: 2_500, taxable: true, stock_quantity: 50 }).select("id").single(), "product");
  made.products.push(lotion.id);
  const card = await must(admin.from("gift_cards").insert({ organization_id: ORG, code: `VP${run.toUpperCase()}`, initial_balance_cents: 5_000, balance_cents: 5_000 }).select("id").single(), "gift card");
  made.giftCards.push(card.id);

  const today = localDateKey(new Date(), ZONE);
  const thisMonth = monthOf(today, ZONE, 0);
  const lastMonth = monthOf(today, ZONE, -1);
  // Inside this month, on a day that is not the first or last, at noon.
  const mid = localToUtc(thisMonth.fromKey, "12:00", ZONE);
  const sale = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: mid, note: `${TAG} sale`, payment: { method: "cash" }, items: [
    { kind: "service", name: "Facial", total_cents: 10_000, staff_id: provider.id },
    { kind: "product", name: `${TAG} Lotion`, total_cents: 2_500, tax_cents: 200, product_id: lotion.id },
    { kind: "discount", name: "Member discount", total_cents: -500 },
    { kind: "tip", name: "Gratuity", total_cents: 1_500, staff_id: provider.id },
  ] });
  const giftSale = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: new Date(mid.getTime() + 3_600_000), note: `${TAG} gift card sale`, payment: { method: "card_external", reference: `gc-${run}` }, items: [
    { kind: "gift_card", name: "Gift card", total_cents: 5_000, gift_card_id: card.id },
  ] });
  const fee = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: new Date(mid.getTime() + 7_200_000), note: `${TAG} fee`, payment: { method: "stripe_card", reference: `pi_vp_${run}` }, items: [
    { kind: "late_cancellation_fee", name: "Late cancellation fee (Facial)", total_cents: 5_000 },
  ] });
  // A second sale, then refunded in full (both this month).
  const refunded = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: new Date(mid.getTime() + 10_800_000), note: `${TAG} refunded sale`, payment: { method: "cash" }, items: [
    { kind: "service", name: "Massage", total_cents: 8_000, staff_id: provider.id },
  ] });
  await refundOf(refunded, ORG, LOC, asker.id, new Date(mid.getTime() + 14_400_000));
  // The month edge: 11:30 PM local on the LAST day of last month (the next
  // UTC day), and 12:30 AM local on the FIRST day of this month.
  const edgeLast = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: localToUtc(lastMonth.toKey, "23:30", ZONE), note: `${TAG} edge last month`, payment: { method: "cash" }, items: [
    { kind: "service", name: "Edge service", total_cents: 3_000, staff_id: provider.id },
  ] });
  const edgeFirst = await txn(ORG, LOC, asker.id, { clientId: noor.id, at: localToUtc(thisMonth.fromKey, "00:30", ZONE), note: `${TAG} edge this month`, payment: { method: "cash" }, items: [
    { kind: "service", name: "Edge service", total_cents: 4_000, staff_id: provider.id },
  ] });
  check("the fixture wrote seven transactions through the triggers (a sale, a gift card, a fee, a sale and its refund, two month-edge sales)", made.transactions.length === 7 && !!sale.id && !!giftSale.id && !!fee.id && !!edgeLast.id && !!edgeFirst.id);

  // ---- agreement: this month ------------------------------------------
  console.log("\nagreement with transactions_page, this month in the location's zone");
  const T = (await totalsOf(asker, thisMonth.from, thisMonth.to)).totals;
  const preset = (await runAsk(PRESET_SQL["financials.revenue_this_month"], asker.userId)).rows[0];
  const MONEY = ["revenue_cents", "service_cents", "retail_cents", "tips_cents", "fees_cents", "gift_cards_sold_cents", "discounts_cents", "tax_cents"];
  check("revenue_this_month equals transactions_page's totals on every figure", same(preset, T, MONEY), describe(preset, T, MONEY));
  // Hand-computed: service 10000 + product 2500 + (8000 − 8000) + 4000 edge = 16500 revenue; the 3000 last-month edge excluded.
  check("…and the figures are the hand-computed ones (revenue 16500: the refunded sale nets to zero; the 11:30 PM last-day sale is LAST month's)", Number(preset.revenue_cents) === 16_500 && Number(preset.tips_cents) === 1_500 && Number(preset.fees_cents) === 5_000 && Number(preset.gift_cards_sold_cents) === 5_000 && Number(preset.discounts_cents) === 500 && Number(preset.tax_cents) === 200, JSON.stringify(preset));
  const L = (await totalsOf(asker, lastMonth.from, lastMonth.to)).totals;
  check("transactions_page for last month holds the 11:30 PM last-day sale (revenue 3000), in the location's month not UTC's", Number(L.revenue_cents) === 3_000, `revenue ${L.revenue_cents}`);
  const edgeMonths = await runAsk(`select local_month::text as m, sum(revenue_cents) as revenue_cents from ledger_lines group by 1 order by 1`, asker.userId);
  const byMonth = Object.fromEntries((edgeMonths.rows ?? []).map((r) => [r.m, Number(r.revenue_cents)]));
  check("ledger_lines files the two edge sales under their own local months", byMonth[lastMonth.fromKey] === 3_000 && byMonth[thisMonth.fromKey] === 16_500, JSON.stringify(byMonth));

  // by provider
  const byStaff = (await totalsOf(asker, thisMonth.from, thisMonth.to)).by_staff.find((s) => s.staff_id === provider.id);
  const provRow = (await runAsk(PRESET_SQL["staff.revenue_by_provider_month"], asker.userId)).rows.find((r) => r.staff_id === provider.id);
  check("revenue_by_provider_month equals by_staff for the provider (service 14000 net of the refund, tips 1500)", provRow && byStaff && Number(provRow.revenue_cents) === Number(byStaff.service_cents) && Number(provRow.tips_cents) === Number(byStaff.tips_cents) && Number(provRow.revenue_cents) === 14_000, `${JSON.stringify(provRow)} vs ${JSON.stringify(byStaff)}`);

  // top spenders: the client's revenue equals transactions_page searched by their name
  const spender = (await runAsk(PRESET_SQL["clients.top_spenders_quarter"], asker.userId)).rows.find((r) => r.client_id === noor.id);
  const quarter = thisMonth; // the fixture's quarter rows are all this month
  const C = (await totalsOf(asker, quarter.from, quarter.to, { p_q: `Presets-${run}` })).totals;
  check("top_spenders_quarter counts the client's REVENUE (net of the refund, no tax, no gift card) and equals transactions_page searched by their name", spender && Number(spender.revenue_cents) === Number(C.revenue_cents) && Number(spender.revenue_cents) === 16_500 && Number(spender.tips_cents) === 1_500, `${JSON.stringify(spender)} vs revenue ${C?.revenue_cents}`);

  // gift cards outstanding: the first row is the liability
  const gcRows = (await runAsk(PRESET_SQL["financials.gift_cards_outstanding"], asker.userId)).rows;
  const { data: liability } = await asker.client.rpc("gift_card_liability");
  check("gift_cards_outstanding's first row equals gift_card_liability() (every active card's balance)", gcRows[0]?.card === "All active cards" && Number(gcRows[0]?.balance_cents) === Number(liability?.liability_cents) && Number(gcRows[0]?.cards) === Number(liability?.active_cards), `${JSON.stringify(gcRows[0])} vs ${JSON.stringify(liability)}`);

  // top services and best sellers: net of the refund
  const svc = (await runAsk(PRESET_SQL["financials.top_services_quarter"], asker.userId)).rows;
  const massage = svc.find((r) => r.service === "Massage");
  check("top_services_quarter nets a refunded service to zero under its own name", massage && Number(massage.revenue_cents) === 0 && Number(massage.times_sold) === 1, JSON.stringify(massage));
  const best = (await runAsk(PRESET_SQL["products.best_sellers_quarter"], asker.userId)).rows.find((r) => r.name === `${TAG} Lotion`);
  check("best_sellers_quarter shows the lotion once at its retail revenue", best && Number(best.units_sold) === 1 && Number(best.revenue_cents) === 2_500, JSON.stringify(best));

  // ---- the views' boundary ---------------------------------------------
  console.log("\nthe views' boundary");
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const a1 = await anon.from("ledger_lines").select("id").limit(1);
  const a2 = await anon.from("ledger_transactions").select("id").limit(1);
  check("an anon session cannot select from ledger_lines or ledger_transactions (42501)", a1.error?.code === "42501" && a2.error?.code === "42501", `${a1.error?.code ?? "no error"}, ${a2.error?.code ?? "no error"}`);

  const west = await must(admin.from("organizations").insert({ name: `${TAG} west`, timezone: "America/Los_Angeles" }).select("id").single(), "org west");
  made.orgs.push(west.id);
  const westLoc = await must(admin.from("locations").insert({ organization_id: west.id, name: `${TAG} west`, timezone: "America/Los_Angeles", tax_rate_bps: 0 }).select("id").single(), "west location");
  made.locations.push(westLoc.id);
  const westRole = await roleWith(west.id, "west asker", ASK_KEYS);
  const westAsker = await staffMember(west.id, "west", westRole);
  await txn(west.id, westLoc.id, westAsker.id, { at: mid, note: `${TAG} west sale`, payment: { method: "cash" }, items: [{ kind: "service", name: "West facial", total_cents: 7_000, staff_id: westAsker.id }] });
  const eastSeesWest = await asker.client.from("ledger_lines").select("id", { count: "exact", head: true }).eq("organization_id", west.id);
  const westSeesEast = await westAsker.client.from("ledger_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG);
  const westOwn = await westAsker.client.from("ledger_lines").select("revenue_cents").eq("organization_id", west.id);
  check("two organisations: the east admin sees none of west's lines and west sees none of east's, each sees their own", eastSeesWest.count === 0 && westSeesEast.count === 0 && (westOwn.data ?? []).reduce((a, r) => a + Number(r.revenue_cents), 0) === 7_000, `east→west ${eastSeesWest.count}, west→east ${westSeesEast.count}, west own ${JSON.stringify(westOwn.data)}`);
  const westAsk = await runAsk(PRESET_SQL["financials.revenue_this_month"], westAsker.userId);
  check("…and Ask's preset for the west admin reports west's revenue only (7000)", westAsk.ok && Number(westAsk.rows[0]?.revenue_cents) === 7_000, westAsk.err ?? JSON.stringify(westAsk.rows?.[0]));

  // a deactivated location keeps its history
  await must(admin.from("locations").update({ active: false }).eq("id", LOC), "deactivate location");
  const afterDeactivate = (await runAsk(PRESET_SQL["financials.revenue_this_month"], asker.userId)).rows[0];
  const Td = (await totalsOf(asker, thisMonth.from, thisMonth.to)).totals;
  check("a deactivated location's past revenue still appears in ledger_lines and transactions_page (16500 both)", Number(afterDeactivate?.revenue_cents) === 16_500 && Number(Td.revenue_cents) === 16_500, `${afterDeactivate?.revenue_cents} / ${Td.revenue_cents}`);
  await must(admin.from("locations").update({ active: true }).eq("id", LOC), "reactivate location");
}

async function cleanup() {
  if (db) {
    try {
      const ids = made.transactions;
      const { rows } = await db.query("select id from transactions where note like $1 or organization_id = any($2::uuid[])", [`${TAG}%`, made.orgs]);
      const all = [...new Set([...ids, ...rows.map((r) => r.id)])];
      if (all.length) {
        await db.query("begin");
        await db.query("set local session_replication_role = replica");
        await db.query("delete from payments where transaction_id = any($1::uuid[])", [all]);
        await db.query("delete from transaction_items where transaction_id = any($1::uuid[])", [all]);
        await db.query("delete from transactions where id = any($1::uuid[]) and refunds_transaction_id is not null", [all]);
        await db.query("delete from transactions where id = any($1::uuid[])", [all]);
        await db.query("commit");
      }
    } catch (e) {
      await db.query("rollback").catch(() => {});
      console.error(`ledger cleanup failed: ${e.message}`);
    } finally {
      await db.end().catch(() => {});
    }
  }
  if (made.giftCards.length) await admin.from("gift_cards").delete().in("id", made.giftCards);
  if (made.products.length) await admin.from("products").delete().in("id", made.products);
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);
  for (const r of made.roleRows) await admin.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
  if (made.staff.length) {
    await scrubTestStaff(dbDsn, made.staff); // what they wrote and what the roles trigger wrote about them
    await admin.from("staff").delete().in("id", made.staff);
  }
  for (const id of made.users) await admin.auth.admin.deleteUser(id);
  for (const id of made.roles) {
    await admin.from("role_permissions").delete().eq("role_id", id);
    await admin.from("roles").delete().eq("id", id);
  }
  if (locationRestore) await admin.from("locations").update({ timezone: locationRestore.timezone, active: locationRestore.active }).eq("id", locationRestore.id);
  if (made.locations.length) await admin.from("locations").delete().in("id", made.locations);
  for (const id of made.orgs) {
    const { error } = await admin.from("organizations").delete().eq("id", id);
    if (error) console.log(`  note  a test organisation could not be deleted: ${error.message}`);
  }
}

try {
  await main();
} catch (e) {
  console.error(`\nHARNESS ERROR (counts as failure): ${e.message}`);
  failed++;
  failures.push(`harness error: ${e.message}`);
} finally {
  await cleanup().catch((e) => console.error(`cleanup failed: ${e.message}`));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
