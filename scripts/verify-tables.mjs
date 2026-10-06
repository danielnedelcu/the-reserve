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
 *     this is what holds the two together).
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
const made = { users: [], staff: [], roleRows: [], roles: [], clients: [], products: [], locations: [], orgs: [] };

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

  // ── 6. two organisations (local stack only) ──────────────────────────
  console.log("\ntwo organisations — one organisation's rows never appear in the other's results");
  if (!LOCAL_MODE) {
    console.log("  skip  two-organisation isolation (needs the local stack: creates a second organisation)");
  } else {
    const west = await must(admin.from("organizations").insert({ name: `${TAG} west`, timezone: "America/Los_Angeles" }).select("id").single(), "org west");
    made.orgs.push(west.id);
    const loc = await must(admin.from("locations").insert({ organization_id: west.id, name: `${TAG} west spa`, timezone: "America/Los_Angeles" }).select("id").single(), "location west");
    made.locations.push(loc.id);
    const westRole = await roleWith(west.id, "west viewer", ["clients.view", "products.view"]);
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
  }
} catch (e) {
  console.error(`\nHARNESS ERROR (counts as failure): ${e.message}`);
  failed++;
  failures.push(`harness error: ${e.message}`);
} finally {
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
