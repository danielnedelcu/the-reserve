/**
 * Server-side tables — boundary verification (docs/design/server-tables-design.md).
 *
 * Each page function answers one page's question in Postgres, as the
 * caller: SECURITY INVOKER, so RLS and current_org_id() apply, and an
 * explicit permission check that raises instead of returning an empty
 * page. So the harness does what the app does — real staff, real sessions
 * through GoTrue, the function called on those sessions — and asserts
 * each rule in BOTH directions:
 *
 *   - without the permission the function raises 42501 (the signal) AND a
 *     direct read returns nothing (the backstop);
 *   - with it, every searched field finds the row; every word must match;
 *     % and _ match themselves; a phone matches on its digits;
 *   - the active filter and the sort whitelist hold, and an unknown sort or
 *     filter raises 22023 (the injection guard);
 *   - pages cover the matches exactly once and a page past the end is
 *     empty with the real total;
 *   - the row carries exactly the list's fields — never date of birth, the
 *     address, the emergency contact;
 *   - two organisations, each with a signed-in holder of the permission,
 *     never see each other's rows (LOCAL stack only: it creates a second
 *     organisation);
 *   - products_page, the same shape: cost_cents and margin_pct reach a
 *     manager and NOT a viewer (both directions), the margin sort is
 *     refused to a viewer, and the low-stock boundary matches the ONE
 *     shared definition, LOW_STOCK_THRESHOLD (the SQL literal is a copy —
 *     this is what holds the two together);
 *   - transactions_page: the totals equal hand-computed figures over a
 *     ledger fixture (a sale with a discount and a tip, a gift-card sale,
 *     a late-cancellation fee, a walk-in, and refunds issued in a LATER
 *     period), do not change with the page size, and come back the same
 *     with p_page_size => 1 (what the cards ask); `refunded` is true on an
 *     original refunded later and false otherwise; by_staff keeps a
 *     deactivated provider's money; a 16-digit reference searches without
 *     an error; the joins degrade visibly (has_client, null names). The
 *     ledger is append-only, so these fixtures exist on the LOCAL stack
 *     only — on hosted the read-only cases run (42501, 22023, the shape)
 *     and the rest prints a skip line.
 *
 * Runs against whatever scripts/_env.mjs resolves: the hosted project from
 * apps/reserve/.env, or the local stack under SUPABASE_LOCAL=true. Rows are
 * tagged VERIFY-TBL-<run> and removed afterwards, even on failure. A
 * connection failure counts as FAIL, never as PASS.
 *
 *   node scripts/verify-tables.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { LOCAL_MODE, guard, supabaseEnv } from "./_env.mjs";
import { LOW_STOCK_THRESHOLD } from "../apps/reserve/shared/products/stock.ts";

const { url, anonKey, serviceKey } = supabaseEnv();
guard(["NUXT_PUBLIC_SUPABASE_URL"]);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const run = randomBytes(4).toString("hex");
const TAG = `VERIFY-TBL-${run}`;
// Digits that are this run's, so a phone search cannot hit a real client.
const DIGITS = String(parseInt(run, 16) % 10_000_000).padStart(7, "0");
const PHONE = `(555) ${DIGITS.slice(0, 3)}-${DIGITS.slice(3)}`;

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

// ---------------------------------------------------------------------------
// Fixtures: staff with real sessions, a role with no permissions, clients
// ---------------------------------------------------------------------------
const made = { users: [], staff: [], roleRows: [], roles: [], clients: [], products: [], transactions: [], locations: [], orgs: [] };

async function staffMember(orgId, label, roleId) {
  const email = `verify-tbl-${label}-${run}@verify.test`;
  const password = `vt-${randomBytes(12).toString("hex")}`;
  const { user } = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), `createUser ${label}`);
  made.users.push(user.id);
  const row = await must(
    admin.from("staff").insert({ organization_id: orgId, user_id: user.id, display_name: `${TAG} ${label}`, email, bookable: false, active: true }).select("id").single(),
    `staff ${label}`,
  );
  made.staff.push(row.id);
  if (roleId) {
    await must(admin.from("staff_roles").insert({ staff_id: row.id, role_id: roleId }), `staff_roles ${label}`);
    made.roleRows.push({ staff_id: row.id, role_id: roleId });
  }
  // A real session, the way the app gets one: GoTrue signs the password in.
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(client.auth.signInWithPassword({ email, password }), `signIn ${label}`);
  return { id: row.id, client };
}

async function roleWith(orgId, name, keys) {
  const role = await must(admin.from("roles").insert({ organization_id: orgId, name: `${TAG} ${name}`, is_system: false }).select("id").single(), `role ${name}`);
  made.roles.push(role.id);
  for (const key of keys) await must(admin.from("role_permissions").insert({ role_id: role.id, permission_key: key }), `role_permissions ${name}`);
  return role.id;
}

async function client(orgId, first, last, extra = {}) {
  const row = await must(
    admin.from("clients").insert({ organization_id: orgId, first_name: first, last_name: last, referral_source: TAG, ...extra }).select("id").single(),
    `client ${first} ${last}`,
  );
  made.clients.push(row.id);
  return row.id;
}

/** clients_page as a session; returns { page, error }. */
async function pageAs(session, args) {
  const { data, error } = await session.client.rpc("clients_page", args);
  return { page: data, error };
}
/** products_page as a session; returns { page, error }. */
async function productsAs(session, args) {
  const { data, error } = await session.client.rpc("products_page", args);
  return { page: data, error };
}
/** transactions_page as a session; returns { page, error }. */
async function txnsAs(session, args) {
  const { data, error } = await session.client.rpc("transactions_page", args);
  return { page: data, error };
}
/**
 * A ledger row with its lines and payment, written by the service role
 * (the ledger has no insert policy for anyone else). Header money follows
 * the checkout route: subtotal = service + product + gift_card lines,
 * discount_cents POSITIVE on the header (the line is negative), total =
 * subtotal - discount + tax + tip.
 */
async function txn(orgId, locationId, cashierId, { clientId = null, at, items, payment, note = null, refunds = null }) {
  const subtotal = items.filter((i) => ["service", "product", "gift_card", "late_cancellation_fee"].includes(i.kind)).reduce((a, i) => a + i.total_cents, 0);
  const discount = -items.filter((i) => i.kind === "discount").reduce((a, i) => a + i.total_cents, 0);
  const tax = items.reduce((a, i) => a + (i.tax_cents ?? 0), 0);
  const tip = items.filter((i) => i.kind === "tip").reduce((a, i) => a + i.total_cents, 0);
  const total = subtotal - discount + tax + tip;
  const row = await must(
    admin.from("transactions").insert({
      organization_id: orgId, location_id: locationId, client_id: clientId, refunds_transaction_id: refunds,
      subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, tip_cents: tip, total_cents: total,
      checked_out_by: cashierId, note, created_at: at,
    }).select("id").single(),
    `transaction ${note ?? at}`,
  );
  made.transactions.push(row.id);
  await must(admin.from("transaction_items").insert(items.map((i) => ({
    transaction_id: row.id, kind: i.kind, name_snapshot: i.name, quantity: 1, unit_price_cents: i.total_cents,
    taxable: (i.tax_cents ?? 0) > 0, tax_cents: i.tax_cents ?? 0, total_cents: i.total_cents, staff_id: i.staff_id ?? null,
  }))), `items ${note ?? at}`);
  // payments_stripe_intent_presence: a stripe_card payment carries its intent id.
  await must(admin.from("payments").insert({ transaction_id: row.id, method: payment.method, amount_cents: total, reference: payment.reference ?? null, stripe_payment_intent_id: payment.method === "stripe_card" ? payment.reference : null }), `payment ${note ?? at}`);
  return { id: row.id, total };
}

async function product(orgId, name, extra = {}) {
  const row = await must(
    admin.from("products").insert({ organization_id: orgId, name: `${TAG} ${name}`, price_cents: 1000, ...extra }).select("id").single(),
    `product ${name}`,
  );
  made.products.push(row.id);
  return row.id;
}
const ids = (page) => (page?.rows ?? []).map((r) => r.id);

let ORG;
try {
  const ping = await admin.from("organizations").select("id, name").order("created_at").limit(1);
  if (ping.error) throw new Error(ping.error.message);
  if (!ping.data?.length) throw new Error("no organizations row");
  ORG = ping.data[0].id;
  console.log(`connected; organisation "${ping.data[0].name}" (run ${run})\n`);
} catch (e) {
  console.log(`CANNOT CONNECT: ${e.message}`);
  console.log("No boundary checks were run.");
  process.exit(1);
}

try {
  // A holder of clients.view through the seeded admin role (it holds every
  // key but five), and a staff member with a role that holds NOTHING — so
  // the exclusion direction is a person who exists, is active, and is
  // simply not allowed.
  const adminRole = await must(admin.from("roles").select("id").eq("organization_id", ORG).eq("name", "admin").single(), "seeded admin role");
  const noneRole = await roleWith(ORG, "nobody", []);
  const holder = await staffMember(ORG, "holder", adminRole.id);
  const nobody = await staffMember(ORG, "nobody", noneRole);

  const maria = await client(ORG, "Maria", `Alvarez-${run}`, { email: `maria.${run}@verify.test`, phone: PHONE, flags: { requires_card_on_file: true } });
  const zed = await client(ORG, "Zed", `Alvarez-${run}`, { no_show_count: 3 });
  const joUnderscore = await client(ORG, "Jo_Ann", `Tester-${run}`);
  const joDash = await client(ORG, "Jo-Ann", `Tester-${run}`);
  const percent = await client(ORG, "Ben", `100%fun-${run}`);
  const inactive = await client(ORG, "Old", `Timer-${run}`, { active: false });
  const all = [maria, zed, joUnderscore, joDash, percent, inactive];

  // ── 1. the permission, both directions ───────────────────────────────
  console.log("clients.view — the signal and the backstop");
  {
    const { error } = await pageAs(nobody, { p_q: `alvarez-${run}` });
    check("a staff member WITHOUT clients.view gets 42501 from clients_page (the signal, not an empty page)", error?.code === "42501", error ? `${error.code} ${error.message}` : "no error");
    const direct = await nobody.client.from("clients").select("id").eq("referral_source", TAG);
    check("…and a direct read under RLS returns nothing (the backstop)", !direct.error && direct.data.length === 0, direct.error?.message ?? `${direct.data?.length} rows`);
    const { page, error: e2 } = await pageAs(holder, { p_q: `alvarez-${run}` });
    check("a holder gets the page (non-vacuous: the same question answered)", !e2 && page?.total === 2, e2?.message ?? `total ${page?.total}`);
  }

  // ── 2. search ────────────────────────────────────────────────────────
  console.log("\nsearch — name, email, phone digits; words AND; escaped");
  {
    const byLast = (await pageAs(holder, { p_q: `alvarez-${run}` })).page;
    check("a last name finds both rows that carry it", byLast?.total === 2 && ids(byLast).length === 2, `total ${byLast?.total}`);
    check("the default sort is the name, ascending: Maria before Zed", ids(byLast)[0] === maria && ids(byLast)[1] === zed);
    check("every word must match: 'maria alvarez' is one row", (await pageAs(holder, { p_q: `maria alvarez-${run}` })).page?.total === 1);
    check("…and 'maria nobody' is none", (await pageAs(holder, { p_q: `maria nobody-${run}` })).page?.total === 0);
    check("the email matches case-insensitively", (await pageAs(holder, { p_q: `MARIA.${run.toUpperCase()}` })).page?.total === 1);
    const spaced = `${DIGITS.slice(0, 3)} ${DIGITS.slice(3, 7)}`;
    const spacedPage = (await pageAs(holder, { p_q: spaced })).page;
    check("a phone matches on its digits, whatever the punctuation typed", spacedPage?.total === 1 && ids(spacedPage)[0] === maria, `q "${spaced}" → total ${spacedPage?.total}`);
    check("two digits do not search the phone (three or more do)", (await pageAs(holder, { p_q: `${DIGITS.slice(0, 2)} tester-${run}` })).page?.total === 0);
    const under = (await pageAs(holder, { p_q: `jo_ann tester-${run}` })).page;
    check("'_' matches itself: 'jo_ann' finds Jo_Ann and not Jo-Ann", under?.total === 1 && ids(under)[0] === joUnderscore, `total ${under?.total}`);
    const pct = (await pageAs(holder, { p_q: `100%fun-${run}` })).page;
    check("'%' matches itself: '100%fun' finds the row", pct?.total === 1 && ids(pct)[0] === percent, `total ${pct?.total}`);
    check("…and '100xfun' does not (the % was not a wildcard)", (await pageAs(holder, { p_q: `100xfun-${run}` })).page?.total === 0);
    const row = byLast.rows.find((r) => r.id === maria);
    check("the row carries exactly the list's fields — nothing sensitive",
      JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["active", "email", "first_name", "id", "last_name", "no_show_count", "phone", "requires_card_on_file"]),
      Object.keys(row).sort().join(","));
    check("requires_card_on_file is read out of flags", row.requires_card_on_file === true && byLast.rows.find((r) => r.id === zed).requires_card_on_file === false);
    check("total_exact is true", byLast.total_exact === true);
  }

  // ── 3. filter, sort, the whitelists ──────────────────────────────────
  console.log("\nfilter and sort");
  {
    check("an inactive client is hidden by default", (await pageAs(holder, { p_q: `timer-${run}` })).page?.total === 0);
    check("…shown with p_active = 'inactive'", (await pageAs(holder, { p_q: `timer-${run}`, p_active: "inactive" })).page?.total === 1);
    check("…and with 'all'", (await pageAs(holder, { p_q: `timer-${run}`, p_active: "all" })).page?.total === 1);
    const desc = (await pageAs(holder, { p_q: `alvarez-${run}`, p_sort: "no_shows", p_desc: true })).page;
    check("sort by no-shows descending puts Zed (3) first", ids(desc)[0] === zed);
    const nameDesc = (await pageAs(holder, { p_q: `alvarez-${run}`, p_sort: "name", p_desc: true })).page;
    check("the name sort reverses", ids(nameDesc)[0] === zed && ids(nameDesc)[1] === maria);
    const inj = await pageAs(holder, { p_sort: "c.id; drop table clients" });
    check("an unknown sort raises 22023 — the injection guard", inj.error?.code === "22023", inj.error ? `${inj.error.code}` : "no error");
    const badActive = await pageAs(holder, { p_active: "everyone" });
    check("an unknown active filter raises 22023", badActive.error?.code === "22023", badActive.error ? `${badActive.error.code}` : "no error");
  }

  // ── 4. paging ────────────────────────────────────────────────────────
  console.log("\npaging");
  {
    const seen = [];
    let total = null;
    for (let p = 1; p <= 3; p++) {
      const page = (await pageAs(holder, { p_q: `-${run}`, p_active: "all", p_page: p, p_page_size: 2 })).page;
      total = page?.total;
      seen.push(...ids(page));
    }
    check("pages of 2 cover the six matches exactly once", seen.length === 6 && new Set(seen).size === 6 && all.every((id) => seen.includes(id)), `${seen.length} rows, ${new Set(seen).size} distinct`);
    check("…with the total on every page", total === 6, `total ${total}`);
    const past = (await pageAs(holder, { p_q: `-${run}`, p_active: "all", p_page: 9, p_page_size: 2 })).page;
    check("a page past the end is empty with the real total", past?.rows.length === 0 && past?.total === 6);
    const clamped = (await pageAs(holder, { p_q: `-${run}`, p_active: "all", p_page: 0, p_page_size: 1000 })).page;
    check("page 0 is page 1 and a page size over 100 is 100", clamped?.rows.length === 6 && clamped?.total === 6);
  }

  // ── 5. products_page ─────────────────────────────────────────────────
  console.log("\nproducts_page — cost for managers only, the shared low-stock boundary");
  const viewerRole = await roleWith(ORG, "viewer", ["products.view"]);
  const viewer = await staffMember(ORG, "viewer", viewerRole);
  const lotion = await product(ORG, "Lavender Lotion", { sku: `LAV-${run}`, price_cents: 2400, cost_cents: 1200, stock_quantity: 12 });
  const oil = await product(ORG, "Rose Oil", { sku: `ROSE-${run}`, price_cents: 1000, cost_cents: null, stock_quantity: 0 });
  const atThreshold = await product(ORG, "Candle at the threshold", { stock_quantity: LOW_STOCK_THRESHOLD, cost_cents: 500, price_cents: 1500 });
  const aboveThreshold = await product(ORG, "Candle above the threshold", { stock_quantity: LOW_STOCK_THRESHOLD + 1 });
  const pct = await product(ORG, "100%pure", { sku: `PURE-${run}`, stock_quantity: 10 });
  const retired = await product(ORG, "Retired", { active: false, stock_quantity: 10 });
  const products = [lotion, oil, atThreshold, aboveThreshold, pct, retired];
  const mine = `verify-tbl-${run}`; // every name carries the tag
  {
    const { error } = await productsAs(nobody, { p_q: mine });
    check("a staff member WITHOUT products.view gets 42501 from products_page", error?.code === "42501", error ? `${error.code}` : "no error");
    const direct = await nobody.client.from("products").select("id").like("name", `${TAG}%`);
    check("…and a direct read under RLS returns nothing", !direct.error && direct.data.length === 0);

    const asViewer = (await productsAs(viewer, { p_q: mine, p_active: "all" })).page;
    check("a viewer (products.view only) gets the rows", asViewer?.total === 6, `total ${asViewer?.total}`);
    const viewerKeys = Object.keys(asViewer.rows[0]).sort();
    check("…with NO cost_cents and NO margin_pct — cost does not reach a viewer",
      !viewerKeys.includes("cost_cents") && !viewerKeys.includes("margin_pct"), viewerKeys.join(","));
    check("…and exactly the catalogue fields",
      JSON.stringify(viewerKeys) === JSON.stringify(["active", "description", "id", "name", "price_cents", "sku", "stock_quantity", "taxable"]), viewerKeys.join(","));
    const viewerMargin = await productsAs(viewer, { p_q: mine, p_sort: "margin" });
    check("a viewer asking to sort by margin gets 42501 (the order would reveal the cost)", viewerMargin.error?.code === "42501", viewerMargin.error?.code ?? "no error");

    const asManager = (await productsAs(holder, { p_q: mine, p_active: "all" })).page;
    const lotionRow = asManager.rows.find((r) => r.id === lotion);
    const oilRow = asManager.rows.find((r) => r.id === oil);
    check("a manager (products.manage) gets cost_cents and margin_pct (non-vacuous: the same rows)", lotionRow?.cost_cents === 1200 && lotionRow?.margin_pct === 50, JSON.stringify({ cost: lotionRow?.cost_cents, margin: lotionRow?.margin_pct }));
    check("…and a product without a cost has margin_pct null, not 100", oilRow && "margin_pct" in oilRow && oilRow.margin_pct === null, JSON.stringify(oilRow?.margin_pct));
    const byMargin = (await productsAs(holder, { p_q: mine, p_active: "all", p_sort: "margin", p_desc: true })).page;
    check("a manager sorts by margin, highest first, nulls last", byMargin?.rows[0]?.id === atThreshold && byMargin.rows[byMargin.rows.length - 1].margin_pct === null, byMargin?.rows.map((r) => r.margin_pct).join(","));

    check("search by SKU finds the one product", (await productsAs(holder, { p_q: `rose-${run}` })).page?.total === 1);
    check("'%' matches itself: '100%pure' finds the row", (await productsAs(holder, { p_q: `100%pure ${mine}` })).page?.total === 1);
    check("…and '100xpure' does not", (await productsAs(holder, { p_q: `100xpure ${mine}` })).page?.total === 0);
    check("every word must match: 'rose lavender' is none", (await productsAs(holder, { p_q: `rose lavender ${mine}` })).page?.total === 0);
    check("an inactive product is hidden by default and shown with 'all'",
      (await productsAs(holder, { p_q: `retired ${mine}` })).page?.total === 0 && (await productsAs(holder, { p_q: `retired ${mine}`, p_active: "all" })).page?.total === 1);

    const out = (await productsAs(holder, { p_q: mine, p_stock: "out" })).page;
    check("stock 'out' is exactly the product with zero", out?.total === 1 && out.rows[0].id === oil, `total ${out?.total}`);
    const low = (await productsAs(holder, { p_q: mine, p_stock: "low" })).page;
    check(`stock 'low' includes a product AT LOW_STOCK_THRESHOLD (${LOW_STOCK_THRESHOLD})`, low?.rows.some((r) => r.id === atThreshold), `rows ${low?.rows.map((r) => r.stock_quantity).join(",")}`);
    check(`…excludes one at LOW_STOCK_THRESHOLD + 1 (${LOW_STOCK_THRESHOLD + 1})`, !low?.rows.some((r) => r.id === aboveThreshold));
    check("…and excludes zero (that is 'out', not 'low')", !low?.rows.some((r) => r.id === oil));
    check("the low filter is only those two rules: exactly one match", low?.total === 1, `total ${low?.total}`);

    const priceDesc = (await productsAs(holder, { p_q: mine, p_active: "all", p_sort: "price", p_desc: true })).page;
    check("sort by price descending puts the lotion ($24) first", priceDesc?.rows[0]?.id === lotion);
    const inj = await productsAs(holder, { p_sort: "p.id; drop table products" });
    check("an unknown sort raises 22023", inj.error?.code === "22023", inj.error?.code ?? "no error");
    const badStock = await productsAs(holder, { p_stock: "plenty" });
    check("an unknown stock filter raises 22023", badStock.error?.code === "22023", badStock.error?.code ?? "no error");

    const seen = [];
    for (let pg = 1; pg <= 3; pg++) seen.push(...((await productsAs(holder, { p_q: mine, p_active: "all", p_page: pg, p_page_size: 2 })).page?.rows ?? []).map((r) => r.id));
    check("pages of 2 cover the six products exactly once", seen.length === 6 && new Set(seen).size === 6 && products.every((id) => seen.includes(id)));
  }

  // ── 6. transactions_page ─────────────────────────────────────────────
  console.log("\ntransactions_page — the signal, the guards, the shape (every stack)");
  const ledgerRole = await roleWith(ORG, "ledger viewer", ["transactions.view"]);
  const ledgerViewer = await staffMember(ORG, "ledger-viewer", ledgerRole);
  const FAR = { p_from: "1999-01-01T00:00:00Z", p_to: "1999-01-02T00:00:00Z" }; // an empty window on any stack
  {
    const { error } = await txnsAs(nobody, FAR);
    check("a staff member WITHOUT transactions.view gets 42501 from transactions_page", error?.code === "42501", error?.code ?? "no error");
    const inj = await txnsAs(holder, { ...FAR, p_sort: "t.id; drop table transactions" });
    check("an unknown sort raises 22023", inj.error?.code === "22023", inj.error?.code ?? "no error");
    const badKind = await txnsAs(holder, { ...FAR, p_kind: "gift" });
    check("an unknown kind raises 22023", badKind.error?.code === "22023", badKind.error?.code ?? "no error");
    const badRange = await txnsAs(holder, { p_from: FAR.p_to, p_to: FAR.p_from });
    check("an empty or reversed range raises 22023 — nothing is ever summed over everything", badRange.error?.code === "22023", badRange.error?.code ?? "no error");
    const shape = (await txnsAs(holder, { ...FAR, p_page_size: 1 })).page;
    check("the answer carries rows, total, total_exact, totals and by_staff",
      JSON.stringify(Object.keys(shape ?? {}).sort()) === JSON.stringify(["by_staff", "rows", "total", "total_exact", "totals"]), Object.keys(shape ?? {}).join(","));
    check("totals carries exactly decision 2's eleven figures, zeros over an empty window",
      JSON.stringify(Object.keys(shape?.totals ?? {}).sort()) === JSON.stringify(["avg_ticket_cents", "discounts_cents", "fees_cents", "gift_cards_sold_cents", "refunds_cents", "retail_cents", "revenue_cents", "service_cents", "tax_cents", "tips_cents", "txn_count"])
        && Object.values(shape?.totals ?? { x: 1 }).every((v) => v === 0),
      JSON.stringify(shape?.totals));
    const longRef = await txnsAs(holder, { ...FAR, p_q: "4242123412341234" });
    check("a 16-digit word is searched as text, never cast as money: no error", !longRef.error && longRef.page?.total === 0, longRef.error?.message ?? `total ${longRef.page?.total}`);
  }

  console.log("\ntransactions_page — the totals over a ledger fixture");
  let eastRevenue = null;
  if (!LOCAL_MODE) {
    console.log("  skip  ledger fixtures (the ledger is append-only: its rows cannot be removed from the hosted project)");
  } else {
    const loc = await must(admin.from("locations").select("id").eq("organization_id", ORG).order("created_at").limit(1).single(), "location");
    const prov = await staffMember(ORG, "provider", null);
    const prov2 = await staffMember(ORG, "former-provider", null);
    const spa = await client(ORG, "Sam", `Ledger-${run}`);
    const MARCH = { p_from: "2001-03-15T00:00:00Z", p_to: "2001-03-16T00:00:00Z" };
    const APRIL = { p_from: "2001-04-20T00:00:00Z", p_to: "2001-04-21T00:00:00Z" };
    const BOTH = { p_from: "2001-03-01T00:00:00Z", p_to: "2001-05-01T00:00:00Z" };
    const t1 = await txn(ORG, loc.id, holder.id, { clientId: spa, at: "2001-03-15T10:00:00Z", note: `${TAG} sale`, items: [
      { kind: "service", name: "Facial", total_cents: 10000, staff_id: prov.id },
      { kind: "product", name: "Lotion", total_cents: 2000, tax_cents: 160 },
      { kind: "tip", name: "Tip", total_cents: 500, staff_id: prov.id },
      { kind: "discount", name: "Member discount", total_cents: -1000 },
    ], payment: { method: "cash" } });
    const t2 = await txn(ORG, loc.id, holder.id, { clientId: spa, at: "2001-03-15T11:00:00Z", note: `${TAG} gift`, items: [
      { kind: "gift_card", name: "Gift card", total_cents: 5000 },
    ], payment: { method: "card_external", reference: "4242123412341234" } });
    const t3 = await txn(ORG, loc.id, holder.id, { clientId: spa, at: "2001-03-15T12:00:00Z", note: `${TAG} fee`, items: [
      { kind: "late_cancellation_fee", name: "Late cancellation fee (Facial)", total_cents: 5000 },
    ], payment: { method: "stripe_card", reference: "pi_verify" } });
    const t4 = await txn(ORG, loc.id, holder.id, { clientId: null, at: "2001-03-15T13:00:00Z", note: `${TAG} walk-in facial`, items: [
      { kind: "service", name: "Express facial", total_cents: 3000, staff_id: prov2.id },
    ], payment: { method: "cash" } });
    // Refunds, issued in a LATER period: mirrors of t1 and of the fee.
    await txn(ORG, loc.id, holder.id, { clientId: spa, at: "2001-04-20T10:00:00Z", note: `${TAG} refund of sale`, refunds: t1.id, items: [
      { kind: "service", name: "Refund — Facial", total_cents: -10000, staff_id: prov.id },
      { kind: "product", name: "Refund — Lotion", total_cents: -2000, tax_cents: -160 },
      { kind: "tip", name: "Refund — Tip", total_cents: -500, staff_id: prov.id },
      { kind: "discount", name: "Refund — Member discount", total_cents: 1000 },
    ], payment: { method: "cash" } });
    await txn(ORG, loc.id, holder.id, { clientId: spa, at: "2001-04-20T11:00:00Z", note: `${TAG} refund of fee`, refunds: t3.id, items: [
      { kind: "late_cancellation_fee", name: "Refund — Late cancellation fee", total_cents: -5000 },
    ], payment: { method: "stripe_card", reference: "pi_verify" } });
    await must(admin.from("staff").update({ active: false }).eq("id", prov2.id), "deactivate former provider");

    const march = (await txnsAs(holder, MARCH)).page;
    const T = march?.totals ?? {};
    check("March: four transactions, the refunds not among them (issued in April)", march?.total === 4 && T.txn_count === 4, JSON.stringify({ total: march?.total, txn_count: T.txn_count }));
    check("revenue = service 13,000 + retail 2,000 = 15,000, pre-tax, GROSS of the discount", T.service_cents === 13000 && T.retail_cents === 2000 && T.revenue_cents === 15000, JSON.stringify(T));
    check("tips 500, discounts 1,000, tax 160 — each its own figure, none inside revenue", T.tips_cents === 500 && T.discounts_cents === 1000 && T.tax_cents === 160);
    check("the gift-card sale (5,000) is a liability figure, never revenue", T.gift_cards_sold_cents === 5000 && T.revenue_cents === 15000);
    check("the late-cancellation fee (5,000) is its own figure, never revenue", T.fees_cents === 5000);
    check("refunds 0 in March, avg ticket = (11,660 + 5,000 + 5,000 + 3,000) / 4 = 6,165", T.refunds_cents === 0 && T.avg_ticket_cents === 6165, `${T.refunds_cents} ${T.avg_ticket_cents}`);
    const april = (await txnsAs(holder, APRIL)).page;
    const A = april?.totals ?? {};
    check("April: refunds 16,660 (the sale's 11,660 and the fee's 5,000), counted when ISSUED, zero tickets", A.refunds_cents === 16660 && A.txn_count === 0 && A.avg_ticket_cents === 0, JSON.stringify(A));
    check("…and the mirrors net the April figures below zero: service -10,000, fees -5,000", A.service_cents === -10000 && A.fees_cents === -5000);
    const both = (await txnsAs(holder, BOTH)).page?.totals ?? {};
    check("March + April together: revenue nets to 3,000 (the walk-in's service; the sale's service AND product mirrored), fees to 0, tax to 0, refunds 16,660 — nothing filtered by sign",
      both.revenue_cents === 3000 && both.service_cents === 3000 && both.retail_cents === 0 && both.fees_cents === 0 && both.tax_cents === 0 && both.refunds_cents === 16660, JSON.stringify(both));
    const oneRow = (await txnsAs(holder, { ...MARCH, p_page_size: 1 })).page;
    check("p_page_size => 1 (what the cards ask) returns the SAME totals as the full page", JSON.stringify(oneRow?.totals) === JSON.stringify(T) && oneRow?.rows.length === 1);
    const pageTwo = (await txnsAs(holder, { ...MARCH, p_page_size: 2, p_page: 2 })).page;
    check("the totals do not change with the page", JSON.stringify(pageTwo?.totals) === JSON.stringify(T) && pageTwo?.rows.length === 2);
    const rowT1 = march.rows.find((r) => r.id === t1.id);
    const rowT2 = march.rows.find((r) => r.id === t2.id);
    check("`refunded` is true on the sale refunded in a LATER period and false on the gift-card sale", rowT1?.refunded === true && rowT2?.refunded === false);
    check("the row carries exactly the table's fields",
      JSON.stringify(Object.keys(rowT1).sort()) === JSON.stringify(["cashier", "cashier_id", "client", "created_at", "discount_cents", "has_client", "id", "items", "note", "payments", "refunded", "refunds_transaction_id", "subtotal_cents", "tax_cents", "tip_cents", "total_cents"]), Object.keys(rowT1).sort().join(","));
    const byStaff = march?.by_staff ?? [];
    const formerRow = byStaff.find((b) => b.staff_id === prov2.id);
    check("by_staff includes the DEACTIVATED provider with their 3,000 (attribution is the line's, not the roster's)", formerRow?.service_cents === 3000 && formerRow?.active === false, JSON.stringify(formerRow));
    check("…and the active provider's 10,000 service + 500 tips", byStaff.find((b) => b.staff_id === prov.id)?.service_cents === 10000 && byStaff.find((b) => b.staff_id === prov.id)?.tips_cents === 500);
    check("by_staff's service sums to totals.service_cents", byStaff.reduce((a, b) => a + b.service_cents, 0) === T.service_cents);

    console.log("\ntransactions_page — search, filters, and the joins that degrade visibly");
    const ref16 = (await txnsAs(holder, { ...MARCH, p_q: "4242123412341234" })).page;
    check("a 16-digit reference finds its payment as TEXT, without an error", ref16?.total === 1 && ref16.rows[0].id === t2.id, `total ${ref16?.total}`);
    check("an amount '$116.60' finds the sale", (await txnsAs(holder, { ...MARCH, p_q: "$116.60" })).page?.total === 1);
    check("an amount '50' finds both 50.00 transactions (the gift card and the fee)", (await txnsAs(holder, { ...MARCH, p_q: "50" })).page?.total === 2);
    check("'walk' finds the walk-in (no client), through the word and the note", (await txnsAs(holder, { ...MARCH, p_q: "walk" })).page?.rows.some((r) => r.id === t4.id));
    check("the client's name finds their three", (await txnsAs(holder, { ...MARCH, p_q: `ledger-${run}` })).page?.total === 3);
    check("an item name finds the sale ('lotion')", (await txnsAs(holder, { ...MARCH, p_q: "lotion" })).page?.total === 1);
    check("kind = sale is the three sales, not the fee", (await txnsAs(holder, { ...MARCH, p_kind: "sale" })).page?.total === 3);
    check("kind = fee is the ORIGINAL fee charge only (and none in April, where its refund is)",
      (await txnsAs(holder, { ...MARCH, p_kind: "fee" })).page?.rows.map((r) => r.id).join() === t3.id && (await txnsAs(holder, { ...APRIL, p_kind: "fee" })).page?.total === 0);
    check("kind = refund in April is both mirrors, the fee's included", (await txnsAs(holder, { ...APRIL, p_kind: "refund" })).page?.total === 2);
    check("method = stripe_card is the fee", (await txnsAs(holder, { ...MARCH, p_method: "stripe_card" })).page?.total === 1);
    check("staff = the provider finds the sale carrying their lines", (await txnsAs(holder, { ...MARCH, p_staff_id: prov.id })).page?.rows.map((r) => r.id).join() === t1.id);
    const viewerPage = (await txnsAs(ledgerViewer, MARCH)).page;
    const vT1 = viewerPage?.rows.find((r) => r.id === t1.id);
    check("a caller with transactions.view and NO clients.view gets has_client true with client null — never a walk-in", vT1?.has_client === true && vT1?.client === null && viewerPage.rows.find((r) => r.id === t4.id)?.has_client === false, JSON.stringify({ has: vT1?.has_client, client: vT1?.client }));
    check("…and NO staff.view: by_staff keeps every line's money under staff_id with the name null, summing to service revenue",
      (viewerPage?.by_staff ?? []).every((b) => b.display_name === null) && viewerPage.by_staff.reduce((a, b) => a + b.service_cents, 0) === 13000 && vT1?.cashier === null, JSON.stringify(viewerPage?.by_staff));
    check("…while the totals are the same as the holder's", JSON.stringify(viewerPage?.totals) === JSON.stringify(T));
    eastRevenue = T.revenue_cents;
  }

  // ── 7. two organisations (local stack only) ──────────────────────────
  console.log("\ntwo organisations — one organisation's rows never appear in the other's results");
  if (!LOCAL_MODE) {
    console.log("  skip  two-organisation isolation (needs the local stack: creates a second organisation)");
  } else {
    const west = await must(admin.from("organizations").insert({ name: `${TAG} west`, timezone: "America/Los_Angeles" }).select("id").single(), "org west");
    made.orgs.push(west.id);
    const loc = await must(admin.from("locations").insert({ organization_id: west.id, name: `${TAG} west spa`, timezone: "America/Los_Angeles" }).select("id").single(), "location west");
    made.locations.push(loc.id);
    const westRole = await roleWith(west.id, "west viewer", ["clients.view", "products.view", "transactions.view"]);
    const westHolder = await staffMember(west.id, "west-holder", westRole);
    await client(west.id, "Maria", `Alvarez-${run}`, { email: `west.${run}@verify.test` });
    await product(west.id, "West Lotion", { sku: `WEST-${run}` });

    const westPage = (await pageAs(westHolder, { p_q: `alvarez-${run}` })).page;
    const eastPage = (await pageAs(holder, { p_q: `alvarez-${run}` })).page;
    check("the west holder sees west's one row (non-vacuous: they hold clients.view and the name matches)", westPage?.total === 1, `total ${westPage?.total}`);
    check("…and none of east's two", !ids(westPage).includes(maria) && !ids(westPage).includes(zed));
    check("the east holder still sees exactly east's two, not west's", eastPage?.total === 2 && !ids(eastPage).some((id) => !all.includes(id)), `total ${eastPage?.total}`);
    const westDirect = await westHolder.client.from("clients").select("id").eq("referral_source", TAG);
    check("a direct read as the west holder is scoped the same way (RLS, the backstop)", !westDirect.error && westDirect.data.length === 1);
    const westProducts = (await productsAs(westHolder, { p_q: mine, p_active: "all" })).page;
    const eastProducts = (await productsAs(holder, { p_q: mine, p_active: "all" })).page;
    check("products: the west viewer sees west's one product and none of east's six", westProducts?.total === 1 && westProducts.rows[0].sku === `WEST-${run}`, `total ${westProducts?.total}`);
    check("products: the east manager still sees exactly east's six", eastProducts?.total === 6 && !eastProducts.rows.some((r) => r.sku === `WEST-${run}`), `total ${eastProducts?.total}`);
    const westStaff = await staffMember(west.id, "west-cashier", null);
    await txn(west.id, loc.id, westStaff.id, { clientId: null, at: "2001-03-15T15:00:00Z", note: `${TAG} west sale`, items: [{ kind: "service", name: "West facial", total_cents: 7000, staff_id: westStaff.id }], payment: { method: "cash" } });
    const MARCH = { p_from: "2001-03-15T00:00:00Z", p_to: "2001-03-16T00:00:00Z" };
    const westTx = (await txnsAs(westHolder, MARCH)).page;
    const eastTx = (await txnsAs(holder, MARCH)).page;
    check("transactions: the west viewer sees west's one sale and totals of 7,000 — none of east's", westTx?.total === 1 && westTx?.totals.revenue_cents === 7000, JSON.stringify({ total: westTx?.total, revenue: westTx?.totals?.revenue_cents }));
    check("transactions: east's totals exclude west's sale (still 15,000 over the same window)", eastTx?.total === 4 && eastTx?.totals.revenue_cents === eastRevenue, JSON.stringify({ total: eastTx?.total, revenue: eastTx?.totals?.revenue_cents }));
  }
} catch (e) {
  console.error(`\nHARNESS ERROR (counts as failure): ${e.message}`);
  failed++;
  failures.push(`harness error: ${e.message}`);
} finally {
  // The ledger fixtures (local stack only): lines and payments first,
  // refunds before the originals they point at.
  if (made.transactions.length) {
    await admin.from("payments").delete().in("transaction_id", made.transactions);
    await admin.from("transaction_items").delete().in("transaction_id", made.transactions);
    await admin.from("transactions").delete().in("id", made.transactions).not("refunds_transaction_id", "is", null);
    await admin.from("transactions").delete().in("id", made.transactions);
  }
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);
  if (made.products.length) await admin.from("products").delete().in("id", made.products);
  for (const r of made.roleRows) await admin.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
  if (made.staff.length) await admin.from("staff").delete().in("id", made.staff);
  for (const id of made.users) await admin.auth.admin.deleteUser(id);
  for (const id of made.roles) {
    await admin.from("role_permissions").delete().eq("role_id", id);
    const { error } = await admin.from("roles").delete().eq("id", id);
    if (error) console.log(`  note  a test role could not be deleted: ${error.message}`);
  }
  if (made.locations.length) await admin.from("locations").delete().in("id", made.locations);
  for (const id of made.orgs) {
    const { error } = await admin.from("organizations").delete().eq("id", id);
    if (error) console.log(`  note  a test organisation could not be deleted: ${error.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
