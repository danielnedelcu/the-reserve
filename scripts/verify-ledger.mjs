/**
 * verify-ledger — the ledger write function and the routes on it
 * (docs/design/ledger-integrity-design.md, PR 1). LOCAL STACK ONLY: it
 * writes ledger rows, and the ledger is append-only on the hosted project.
 *
 * Two layers, each non-vacuous (a rejected write is checked to have
 * written NOTHING; an accepted one is checked row by row):
 *   1. write_ledger_transaction called directly as the service role:
 *      a balanced sale lands as one transaction; a genuine retry returns
 *      the same id and writes nothing; the same key with a different
 *      total, or a product swapped at the same price, raises LD001; an
 *      unknown JSON key raises 22023; a client, gift card, staff member
 *      or location from another organisation raises LD002; a gift-card
 *      overdraft inside the payments rolls the header back; the fee
 *      writer's exact rows pass.
 *   2. the real routes, through the running app with a real session:
 *      POST /api/checkout once, again (same id), with an edited cart
 *      under the same key (409 naming the first), then
 *      POST /api/transactions/:id/refund (the mirror), and again (409).
 *   3. the invariants at COMMIT (PR 2): for each rule an unbalanced
 *      write is rejected with that rule's name and nothing survives, a
 *      balanced one is accepted; a second refund of an original and a
 *      refund of a refund are refused; update, delete and truncate are
 *      refused under the service role on all three tables; an
 *      authenticated session cannot call assert_ledger_transaction; a
 *      client with sales history cannot be deleted, one without can.
 *
 * Cleanup removes this run's rows through the direct postgres connection
 * with session_replication_role = replica — the only path past the
 * append-only block, behind the localhost guard. The service role has
 * no such path, which is what makes the block hold in production.
 *
 *   SUPABASE_LOCAL=true node scripts/verify-ledger.mjs   (app up on E2E_BASE_URL or :3300)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { LOCAL_MODE, get, guard, isLocalUrl, pgSsl, supabaseEnv } from "./_env.mjs";
import { scrubTestStaff } from "./_cleanup.mjs";

guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const { url, anonKey, serviceKey } = supabaseEnv();
const dsn = get("DATABASE_URL");
if (!LOCAL_MODE || !isLocalUrl(url) || !isLocalUrl(dsn)) {
  console.error("\nHARNESS ERROR (counts as failure): verify-ledger writes ledger rows and runs on the LOCAL stack only (SUPABASE_LOCAL=true).");
  process.exit(1);
}
const base = (process.env.E2E_BASE_URL ?? "http://localhost:3300").replace(/\/$/, "");

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const db = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
await db.connect();
const run = randomBytes(4).toString("hex");
const TAG = `VERIFY-LEDGER-${run}`;

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

const made = { users: [], staff: [], roleRows: [], roles: [], clients: [], products: [], giftCards: [], transactions: [], locations: [], orgs: [] };

/** A session's rpc as that session; returns { data, error }. */
const rpcAs = (session, fn, args) => session.client.rpc(fn, args);

async function staffMember(orgId, label, roleId) {
  const email = `verify-ledger-${label}-${run}@verify.test`;
  const password = `vl-${randomBytes(12).toString("hex")}`;
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
  // A real session the way the app reads one: @supabase/ssr signs in and
  // writes its cookies to a jar; the jar becomes the Cookie header.
  const jar = new Map();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  await must(ssr.auth.signInWithPassword({ email, password }), `signIn ${label}`);
  for (let i = 0; i < 20 && !jar.size; i++) await new Promise((r) => setTimeout(r, 25));
  if (!jar.size) throw new Error(`signIn ${label}: no cookies were written`);
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  return { id: row.id, cookie, client: ssr };
}
async function roleWith(orgId, name, keys) {
  const role = await must(admin.from("roles").insert({ organization_id: orgId, name: `${TAG} ${name}`, is_system: false }).select("id").single(), `role ${name}`);
  made.roles.push(role.id);
  for (const key of keys) await must(admin.from("role_permissions").insert({ role_id: role.id, permission_key: key }), `role_permissions ${name}`);
  return role.id;
}
async function client(orgId, first) {
  const row = await must(admin.from("clients").insert({ organization_id: orgId, first_name: first, last_name: TAG, referral_source: TAG }).select("id").single(), `client ${first}`);
  made.clients.push(row.id);
  return row.id;
}
async function product(orgId, name, priceCents) {
  const row = await must(admin.from("products").insert({ organization_id: orgId, name: `${TAG} ${name}`, sku: `VL-${run}-${name}`, price_cents: priceCents, taxable: false, stock_quantity: 50 }).select("id").single(), `product ${name}`);
  made.products.push(row.id);
  return row.id;
}
async function giftCard(orgId, balanceCents) {
  const code = `VL${run.toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`;
  const row = await must(admin.from("gift_cards").insert({ organization_id: orgId, code, initial_balance_cents: balanceCents, balance_cents: balanceCents }).select("id").single(), "gift card");
  made.giftCards.push(row.id);
  return row.id;
}
async function post(path, cookie, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
/** The rows a transaction has, as the proof reads them. */
async function rowsOf(id) {
  const txn = (await admin.from("transactions").select("*").eq("id", id).maybeSingle()).data;
  const items = (await admin.from("transaction_items").select("*").eq("transaction_id", id).order("kind")).data ?? [];
  const payments = (await admin.from("payments").select("*").eq("transaction_id", id).order("method")).data ?? [];
  return { txn, items, payments };
}
async function countByKey(orgId, key) {
  const { count } = await admin.from("transactions").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("idempotency_key", key);
  return count ?? 0;
}
const write = (orgId, key, header, items, payments) =>
  admin.rpc("write_ledger_transaction", { p_organization_id: orgId, p_idempotency_key: key, p_header: header, p_items: items, p_payments: payments });

function line(kind, extra) {
  return { kind, appointment_id: null, product_id: null, gift_card_id: null, staff_id: null, name_snapshot: `${TAG} ${kind}`, quantity: 1, unit_price_cents: 0, taxable: false, tax_cents: 0, total_cents: 0, discount_reason: null, ...extra };
}

async function main() {
  const org = await must(admin.from("organizations").select("id").order("created_at").limit(1).single(), "seeded organisation");
  const ORG = org.id;
  const loc = await must(admin.from("locations").select("id").eq("organization_id", ORG).order("created_at").limit(1).single(), "seeded location");
  const LOC = loc.id;
  console.log(`\nverify-ledger (${TAG}) — ${url}, app ${base}\n`);

  const cashierRole = await roleWith(ORG, "cashier", ["pos.checkout", "pos.refund", "transactions.view", "clients.view", "products.view"]);
  const cashier = await staffMember(ORG, "cashier", cashierRole);
  const colleague = await staffMember(ORG, "colleague", cashierRole); // retries the same cart
  const noor = await client(ORG, "Noor");
  const lotion = await product(ORG, "lotion", 2_500);
  const balm = await product(ORG, "balm", 2_500); // the same price as the lotion, for the swap case
  const card = await giftCard(ORG, 5_000);

  // Another organisation, with its own location, client, staff and card.
  const west = await must(admin.from("organizations").insert({ name: `${TAG} west`, timezone: "America/Los_Angeles" }).select("id").single(), "org west");
  made.orgs.push(west.id);
  const westLoc = await must(admin.from("locations").insert({ organization_id: west.id, name: `${TAG} west`, timezone: "America/Los_Angeles", tax_rate_bps: 0 }).select("id").single(), "west location");
  made.locations.push(westLoc.id);
  const westClient = await client(west.id, "Wes");
  const westStaff = await staffMember(west.id, "west-staff", null);
  const westCard = await giftCard(west.id, 5_000);

  const header = (over = {}) => ({ location_id: LOC, client_id: noor, appointment_id: null, subtotal_cents: 2_500, discount_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 2_500, checked_out_by: cashier.id, note: TAG, ...over });
  const lotionLine = line("product", { product_id: lotion, unit_price_cents: 2_500, total_cents: 2_500 });
  const cash = (amount = 2_500) => ({ method: "cash", amount_cents: amount, gift_card_id: null, reference: null, stripe_payment_intent_id: null });

  // ── 1. the function ───────────────────────────────────────────────────
  console.log("write_ledger_transaction — the function, as the service role");
  const key1 = `vl-${run}:sale`;
  const { data: id1, error: e1 } = await write(ORG, key1, header(), [lotionLine], [cash()]);
  if (id1) made.transactions.push(id1);
  {
    const r = id1 ? await rowsOf(id1) : null;
    check("a balanced cash sale lands as one transaction with its line and its payment", !e1 && r?.txn?.total_cents === 2_500 && r.items.length === 1 && r.items[0].product_id === lotion && r.payments.length === 1 && r.payments[0].amount_cents === 2_500, e1?.message ?? "");
    check("the header carries the key", r?.txn?.idempotency_key === key1);
  }
  {
    const { data: again, error } = await write(ORG, key1, header(), [lotionLine], [cash()]);
    const r = await rowsOf(id1);
    check("a genuine retry (same key, same request) returns the same id and writes nothing", !error && again === id1 && (await countByKey(ORG, key1)) === 1 && r.items.length === 1 && r.payments.length === 1, error?.message ?? `got ${again}`);
  }
  {
    const { error } = await write(ORG, key1, header({ subtotal_cents: 2_600, total_cents: 2_600 }), [{ ...lotionLine, unit_price_cents: 2_600, total_cents: 2_600 }], [cash(2_600)]);
    check("the same key with a different total raises LD001 naming the first transaction", error?.code === "LD001" && error?.details === id1, `${error?.code ?? "no error"} ${error?.details ?? ""}`);
    check("…and writes nothing", (await countByKey(ORG, key1)) === 1);
  }
  {
    const { error } = await write(ORG, key1, header(), [{ ...lotionLine, product_id: balm }], [cash()]);
    check("the same key with a product swapped for another at the same price raises LD001 (not a retry)", error?.code === "LD001", error?.code ?? "no error");
  }
  {
    const { error } = await write(ORG, key1, header(), [lotionLine], [{ ...cash(), method: "card_external" }]);
    check("the same key with a different tender raises LD001", error?.code === "LD001", error?.code ?? "no error");
  }
  {
    const { error } = await write(ORG, key1, header({ client_id: null }), [lotionLine], [cash()]);
    check("the same key with only the client changed raises LD001 (the header is compared too)", error?.code === "LD001" && (await countByKey(ORG, key1)) === 1, error?.code ?? "no error");
    const { error: e2 } = await write(ORG, key1, header({ discount_cents: 100, subtotal_cents: 2_600 }), [lotionLine], [cash()]);
    check("the same key with the money fields rearranged under the same total raises LD001", e2?.code === "LD001", e2?.code ?? "no error");
    const { data: byColleague, error: e3 } = await write(ORG, key1, header({ checked_out_by: colleague.id, note: "retried" }), [lotionLine], [cash()]);
    check("the same key retried by a colleague (only checked_out_by and note differ) returns the existing id — the same sale", !e3 && byColleague === id1 && (await countByKey(ORG, key1)) === 1, e3?.message ?? `got ${byColleague}`);
  }
  {
    const bad = header(); bad.cleint_id = bad.client_id; delete bad.client_id;
    const { error } = await write(ORG, `vl-${run}:badkey`, bad, [lotionLine], [cash()]);
    check("an unknown header key (cleint_id) raises 22023 naming it", error?.code === "22023" && /cleint_id/.test(error?.message ?? ""), `${error?.code ?? "no error"}: ${error?.message ?? ""}`);
    check("…and writes nothing", (await countByKey(ORG, `vl-${run}:badkey`)) === 0);
    const { error: e2 } = await write(ORG, `vl-${run}:badline`, header(), [{ ...lotionLine, prodcut_id: lotion }], [cash()]);
    check("an unknown line key raises 22023", e2?.code === "22023" && /prodcut_id/.test(e2?.message ?? ""), e2?.code ?? "no error");
    const { error: e3 } = await write(ORG, `vl-${run}:badpay`, header(), [lotionLine], [{ ...cash(), amount: 2_500 }]);
    check("an unknown payment key raises 22023", e3?.code === "22023" && /amount/.test(e3?.message ?? ""), e3?.code ?? "no error");
    const { error: e4 } = await write(ORG, `vl-${run}:nolines`, header(), [], [cash()]);
    check("no lines raises 22023", e4?.code === "22023", e4?.code ?? "no error");
  }
  {
    const cases = [
      ["a client from another organisation", header({ client_id: westClient }), [lotionLine], [cash()]],
      ["a location from another organisation", header({ location_id: westLoc.id }), [lotionLine], [cash()]],
      ["a cashier from another organisation", header({ checked_out_by: westStaff.id }), [lotionLine], [cash()]],
      ["a tip line attributed to staff from another organisation", header({ tip_cents: 500, total_cents: 3_000 }), [lotionLine, line("tip", { staff_id: westStaff.id, unit_price_cents: 500, total_cents: 500 })], [cash(3_000)]],
      ["a gift-card payment from another organisation", header(), [lotionLine], [{ method: "gift_card", amount_cents: 2_500, gift_card_id: westCard, reference: null, stripe_payment_intent_id: null }]],
    ];
    for (const [name, h, items, pays] of cases) {
      const key = `vl-${run}:xorg:${name.replace(/\W+/g, "-")}`;
      const { error } = await write(ORG, key, h, items, pays);
      check(`${name} raises LD002 and writes nothing`, error?.code === "LD002" && (await countByKey(ORG, key)) === 0, error?.code ?? "no error");
    }
  }
  {
    // Atomicity: the gift-card trigger raises on the PAYMENT; the header
    // and the line written before it must roll back with it.
    const key = `vl-${run}:overdraft`;
    const { error } = await write(ORG, key, header({ subtotal_cents: 9_000, total_cents: 9_000 }), [{ ...lotionLine, unit_price_cents: 9_000, total_cents: 9_000 }], [{ method: "gift_card", amount_cents: 9_000, gift_card_id: card, reference: null, stripe_payment_intent_id: null }]);
    const balance = (await admin.from("gift_cards").select("balance_cents").eq("id", card).single()).data?.balance_cents;
    check("a gift-card overdraft on the payment fails the write and NO header or line survives (one transaction)", !!error && (await countByKey(ORG, key)) === 0 && balance === 5_000, error ? `balance ${balance}` : "no error");
  }
  {
    // The fee writer's exact rows (the cancel route builds these; driving
    // the route needs a Stripe test-mode charge — board).
    const { data: systemStaffId } = await admin.rpc("system_staff_id", { p_organization_id: ORG });
    const pi = `pi_vl_${run}`;
    const feeHeader = { location_id: LOC, client_id: noor, appointment_id: null, subtotal_cents: 5_000, discount_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 5_000, checked_out_by: systemStaffId, note: "Late cancellation fee (cancelled via link)" };
    const feeLine = line("late_cancellation_fee", { name_snapshot: "Late cancellation fee (Facial)", unit_price_cents: 5_000, total_cents: 5_000 });
    const feePay = { method: "stripe_card", amount_cents: 5_000, gift_card_id: null, reference: pi, stripe_payment_intent_id: pi };
    const { data: feeId, error } = await write(ORG, `pi:${pi}`, feeHeader, [feeLine], [feePay]);
    if (feeId) made.transactions.push(feeId);
    const r = feeId ? await rowsOf(feeId) : null;
    check("the fee writer's exact rows pass: one fee line, one stripe_card payment carrying the intent", !!systemStaffId && !error && r?.items[0]?.kind === "late_cancellation_fee" && r.payments[0]?.stripe_payment_intent_id === pi, error?.message ?? (systemStaffId ? "" : "no system staff"));
    const { data: feeAgain } = await write(ORG, `pi:${pi}`, feeHeader, [feeLine], [feePay]);
    check("a retried fee (same intent) returns the same transaction", feeAgain === feeId && (await countByKey(ORG, `pi:${pi}`)) === 1);
  }
  {
    const key = `vl-${run}:zero`;
    const { data: zeroId, error } = await write(ORG, key, header({ discount_cents: 2_500, total_cents: 0 }), [lotionLine, line("discount", { unit_price_cents: -2_500, total_cents: -2_500, discount_reason: "comp" })], []);
    if (zeroId) made.transactions.push(zeroId);
    check("a zero-total sale (fully discounted) writes with no payment rows", !error && !!zeroId && (await rowsOf(zeroId)).payments.length === 0, error?.message ?? "");
  }

  // ── 3. the invariants, at commit ─────────────────────────────────────
  console.log("\nthe invariants — checked at commit (PR 2); each rule by name, nothing surviving a rejection");
  const rule = async (name, expectedRule, h, items, pays, keySuffix) => {
    const key = `vl-${run}:inv:${keySuffix}`;
    const { error } = await write(ORG, key, h, items, pays);
    const named = error?.code === "LD010" && (error?.message ?? "").includes(`ledger.${expectedRule}:`);
    check(`${name} → ledger.${expectedRule}, and nothing survives`, named && (await countByKey(ORG, key)) === 0, `${error?.code ?? "no error"}: ${(error?.message ?? "").slice(0, 100)}`);
  };
  await rule("payments short of the total", "payments", header(), [lotionLine], [cash(2_000)], "payments");
  await rule("a zero total with a payment row", "zero_total", header({ discount_cents: 2_500, total_cents: 0 }), [lotionLine, line("discount", { unit_price_cents: -2_500, total_cents: -2_500, discount_reason: "comp" })], [cash(0)], "zero");
  await rule("sale lines not summing to the subtotal", "subtotal", header({ subtotal_cents: 2_600, total_cents: 2_600 }), [lotionLine], [cash(2_600)], "subtotal");
  await rule("a discount line not matching discount_cents", "discount", header({ discount_cents: 500, total_cents: 2_000 }), [lotionLine, line("discount", { unit_price_cents: -400, total_cents: -400, discount_reason: "x" })], [cash(2_000)], "discount");
  await rule("a tip line not matching tip_cents", "tip", header({ tip_cents: 500, total_cents: 3_000 }), [lotionLine, line("tip", { staff_id: cashier.id, unit_price_cents: 400, total_cents: 400 })], [cash(3_000)], "tip");
  await rule("line tax not matching tax_cents", "tax", header({ tax_cents: 200, total_cents: 2_700 }), [{ ...lotionLine, taxable: true, tax_cents: 100 }], [cash(2_700)], "tax");
  {
    // No lines at all: the function refuses that before the trigger, so
    // the trigger is proven on the direct connection, as the postgres role.
    let err = null;
    try {
      await db.query("begin");
      await db.query(`insert into transactions (organization_id, location_id, client_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, checked_out_by, note, idempotency_key) values ($1,$2,$3,0,0,0,0,0,$4,$5,$6)`, [ORG, LOC, noor, cashier.id, TAG, `vl-${run}:inv:nolines`]);
      await db.query("commit");
    } catch (e) { err = e; await db.query("rollback").catch(() => {}); }
    check("a header with no lines is rejected at commit on the direct connection → ledger.lines (the trigger binds the postgres role too)", err?.code === "LD010" && /ledger\.lines:/.test(err?.message ?? "") && (await countByKey(ORG, `vl-${run}:inv:nolines`)) === 0, `${err?.code ?? "no error"}: ${(err?.message ?? "").slice(0, 80)}`);
  }
  {
    const { error } = await write(ORG, `vl-${run}:inv:qty`, header({ subtotal_cents: 5_000, total_cents: 5_000 }), [{ ...lotionLine, quantity: 2, unit_price_cents: 2_500, total_cents: 5_001 }], [cash(5_001)]);
    check("a line whose total is not quantity × unit price is refused immediately (check constraint 23514)", error?.code === "23514", error?.code ?? "no error");
  }
  // Refunds of the balanced sale id1: the broken mirrors first, then the real one.
  const mirrorHeader = (over = {}) => ({ location_id: LOC, client_id: noor, appointment_id: null, refunds_transaction_id: id1, subtotal_cents: -2_500, discount_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: -2_500, checked_out_by: cashier.id, note: `${TAG} refund`, ...over });
  const mirrorLine = { ...lotionLine, unit_price_cents: -2_500, total_cents: -2_500 };
  await rule("a refund whose client differs from the original's", "refund_header", mirrorHeader({ client_id: null }), [mirrorLine], [cash(-2_500)], "rh");
  await rule("a refund with the right sums but two lines where the original has one", "refund_lines", mirrorHeader(), [{ ...mirrorLine, unit_price_cents: -1_250, total_cents: -1_250 }, { ...mirrorLine, unit_price_cents: -1_250, total_cents: -1_250 }], [cash(-2_500)], "rl");
  await rule("a refund with two payments where the original has one", "refund_payments", mirrorHeader(), [mirrorLine], [cash(-1_250), cash(-1_250)], "rp");
  const { data: refund1, error: refundErr } = await write(ORG, `refund:${id1}`, mirrorHeader(), [mirrorLine], [cash(-2_500)]);
  if (refund1) made.transactions.push(refund1);
  check("the exact mirror is accepted", !refundErr && !!refund1, refundErr?.message ?? "");
  {
    const { error } = await write(ORG, `vl-${run}:inv:second-refund`, mirrorHeader(), [mirrorLine], [cash(-2_500)]);
    check("a second refund of the same original is refused by the partial unique index (23505)", error?.code === "23505" && (await countByKey(ORG, `vl-${run}:inv:second-refund`)) === 0, error?.code ?? "no error");
  }
  await rule("a refund of a refund", "refund_of_refund", mirrorHeader({ refunds_transaction_id: refund1, subtotal_cents: 2_500, total_cents: 2_500 }), [lotionLine], [cash(2_500)], "rr");

  console.log("\nappend-only — update, delete and truncate refused for the service role");
  {
    const u = await admin.from("transactions").update({ note: "edited" }).eq("id", id1);
    const d = await admin.from("transactions").delete().eq("id", id1);
    const ui = await admin.from("transaction_items").update({ name_snapshot: "edited" }).eq("transaction_id", id1);
    const di = await admin.from("transaction_items").delete().eq("transaction_id", id1);
    const up = await admin.from("payments").update({ reference: "edited" }).eq("transaction_id", id1);
    const dp = await admin.from("payments").delete().eq("transaction_id", id1);
    const all = [u, d, ui, di, up, dp];
    check("update and delete on transactions, transaction_items and payments all raise LD003 through the service-role API", all.every((r) => r.error?.code === "LD003"), all.map((r) => r.error?.code ?? "no error").join(","));
    const r = await rowsOf(id1);
    check("…and the rows are untouched", r.txn?.note === TAG && r.items.length === 1 && r.payments.length === 1);
    let trunc = null;
    try {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("truncate transactions");
    } catch (e) { trunc = e; }
    await db.query("rollback").catch(() => {});
    check("truncate transactions as service_role is refused (42501: the privilege is gone)", trunc?.code === "42501", trunc?.code ?? "no error");
    let direct = null;
    try {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("delete from payments where transaction_id = $1", [id1]);
    } catch (e) { direct = e; }
    await db.query("rollback").catch(() => {});
    check("a delete as service_role on a direct connection raises LD003 too (the block is a trigger, not a policy)", direct?.code === "LD003", direct?.code ?? "no error");
  }
  {
    const { error } = await rpcAs(cashier, "assert_ledger_transaction", { p_transaction_id: id1 });
    check("an authenticated session calling assert_ledger_transaction directly gets a permission error (42501)", error?.code === "42501", error?.code ?? "no error");
  }
  {
    const { error } = await admin.from("clients").delete().eq("id", noor);
    const still = (await admin.from("clients").select("id").eq("id", noor).maybeSingle()).data;
    check("deleting a client with sales history is refused by the foreign key (23503) and the client remains", error?.code === "23503" && !!still, error?.code ?? "no error");
    const ghost = await client(ORG, "Ghost");
    const { error: e2 } = await admin.from("clients").delete().eq("id", ghost);
    const gone = !(await admin.from("clients").select("id").eq("id", ghost).maybeSingle()).data;
    check("a client with no history is deleted normally", !e2 && gone, e2?.message ?? "still there");
    made.clients = made.clients.filter((c) => c !== ghost);
  }

  // ── 2. the routes ─────────────────────────────────────────────────────
  console.log("\nthe routes — checkout and refund through the running app, with a real session");
  const ping = await fetch(base).catch(() => null);
  if (!ping) {
    check(`the app answers at ${base} (start it: npm run build:check && npm run app:start)`, false, "no server");
  } else {
    const cartKey = randomUUID();
    const body = { idempotencyKey: cartKey, clientId: noor, appointmentId: null, items: [{ kind: "product", productId: lotion, quantity: 1 }], payments: [{ method: "cash", amountCents: 2_500 }] };
    const first = await post("/api/checkout", cashier.cookie, body);
    const saleId = first.json?.id;
    if (saleId) made.transactions.push(saleId);
    const r = saleId ? await rowsOf(saleId) : null;
    check("POST /api/checkout records a cash sale: header 2500, one product line, one cash payment, key checkout:<cart>", first.status === 200 && r?.txn?.total_cents === 2_500 && r.items.length === 1 && r.payments[0]?.method === "cash" && r.txn.idempotency_key === `checkout:${cartKey}`, `${first.status} ${first.text.slice(0, 120)}`);
    const again = await post("/api/checkout", cashier.cookie, body);
    check("the same request again (a retry) returns the same id and leaves one transaction", again.status === 200 && again.json?.id === saleId && (await countByKey(ORG, `checkout:${cartKey}`)) === 1, `${again.status} ${again.text.slice(0, 120)}`);
    const edited = await post("/api/checkout", cashier.cookie, { ...body, items: [{ kind: "product", productId: lotion, quantity: 2 }], payments: [{ method: "cash", amountCents: 5_000 }] });
    check("an edited cart under the same key is a 409 naming the first transaction, and writes nothing", edited.status === 409 && edited.json?.data?.transactionId === saleId && (await countByKey(ORG, `checkout:${cartKey}`)) === 1, `${edited.status} ${edited.text.slice(0, 160)}`);
    const missing = await post("/api/checkout", cashier.cookie, { ...body, idempotencyKey: undefined });
    check("a checkout without a key is refused (422)", missing.status === 422, String(missing.status));

    const refund = saleId ? await post(`/api/transactions/${saleId}/refund`, cashier.cookie, {}) : { status: 0, json: null, text: "" };
    const refundId = refund.json?.id;
    if (refundId) made.transactions.push(refundId);
    const m = refundId ? await rowsOf(refundId) : null;
    check("POST /api/transactions/:id/refund writes the mirror: −2500 header, the line and the payment negated, key refund:<original>", refund.status === 200 && m?.txn?.total_cents === -2_500 && m.txn.refunds_transaction_id === saleId && m.items[0]?.total_cents === -2_500 && m.payments[0]?.amount_cents === -2_500 && m.txn.idempotency_key === `refund:${saleId}`, `${refund.status} ${refund.text.slice(0, 120)}`);
    {
      const audit = (await admin.from("audit_log").select("action, organization_id").in("entity_id", [saleId, refundId].filter(Boolean)).order("id")).data ?? [];
      check("the checkout and refund routes' audit rows carry the organisation (pos.checkout on the sale, pos.refund on the original)", audit.length >= 2 && audit.every((a) => a.organization_id === ORG) && audit.some((a) => a.action === "pos.checkout") && audit.some((a) => a.action === "pos.refund"), JSON.stringify(audit));
    }
    const refundAgain = saleId ? await post(`/api/transactions/${saleId}/refund`, cashier.cookie, {}) : { status: 0, json: null, text: "" };
    check("refunding again is a 409 naming the existing mirror, and leaves one", refundAgain.status === 409 && refundAgain.json?.data?.refundTransactionId === refundId && (await countByKey(ORG, `refund:${saleId}`)) === 1, `${refundAgain.status} ${refundAgain.text?.slice(0, 120) ?? ""}`);
  }
}

async function cleanup() {
  // Ledger rows go through the direct postgres connection ONLY, with the
  // append-only block skipped for this one transaction (localhost
  // guarded above): the API path cannot remove a ledger row, by design.
  try {
    const { rows } = await db.query("select id from transactions where idempotency_key like $1 or note like $2 or organization_id = any($3::uuid[])", [`%${run}%`, `${TAG}%`, made.orgs]);
    const ids = [...new Set([...made.transactions, ...rows.map((r) => r.id)])];
    if (ids.length) {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("delete from payments where transaction_id = any($1::uuid[])", [ids]);
      await db.query("delete from transaction_items where transaction_id = any($1::uuid[])", [ids]);
      await db.query("delete from transactions where id = any($1::uuid[]) and refunds_transaction_id is not null", [ids]);
      await db.query("delete from transactions where id = any($1::uuid[])", [ids]);
      await db.query("commit");
    }
  } catch (e) {
    await db.query("rollback").catch(() => {});
    console.error(`ledger cleanup failed: ${e.message}`);
  } finally {
    await db.end().catch(() => {});
  }
  if (made.giftCards.length) await admin.from("gift_cards").delete().in("id", made.giftCards);
  if (made.products.length) await admin.from("products").delete().in("id", made.products);
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);
  for (const r of made.roleRows) await admin.from("staff_roles").delete().eq("staff_id", r.staff_id).eq("role_id", r.role_id);
  if (made.staff.length) {
    await scrubTestStaff(dsn, made.staff); // what they wrote and what the roles trigger wrote about them
    await admin.from("staff").delete().in("id", made.staff);
  }
  for (const id of made.users) await admin.auth.admin.deleteUser(id);
  for (const id of made.roles) {
    await admin.from("role_permissions").delete().eq("role_id", id);
    await admin.from("roles").delete().eq("id", id);
  }
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
