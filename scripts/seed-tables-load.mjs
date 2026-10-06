/**
 * Load seed for the server-side tables benchmark (docs/design/server-tables-design.md,
 * decision 7). Puts 10,000 clients and 2,000 products into the seeded
 * organisation on the LOCAL stack — never anywhere else: it refuses to run
 * without SUPABASE_LOCAL=true and the localhost guard. Clients are tagged
 * referral_source = 'LOAD-SEED', products are named 'LOAD-SEED …';
 * `--clean` removes both.
 *
 *   npm run seed:tables            seed 10,000 clients (or N with --count N) and 2,000 products
 *   npm run seed:tables -- --clean remove them
 */
import { createClient } from "@supabase/supabase-js";
import { LOCAL_MODE, guard, supabaseEnv } from "./_env.mjs";

if (!LOCAL_MODE) {
  console.error("SAFETY: the load seed runs on the LOCAL stack only. Set SUPABASE_LOCAL=true with the stack's env exported.");
  process.exit(1);
}
guard(["NUXT_PUBLIC_SUPABASE_URL"]);
const { url, serviceKey } = supabaseEnv();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const TAG = "LOAD-SEED";

const org = await admin.from("organizations").select("id, name").order("created_at").limit(1).maybeSingle();
if (org.error || !org.data) {
  console.error("No organisation on the local stack (reset it from the migrations first).");
  process.exit(1);
}

if (process.argv.includes("--clean")) {
  const { error, count } = await admin.from("clients").delete({ count: "exact" }).eq("referral_source", TAG);
  if (error) {
    console.error(`clean failed: ${error.message}`);
    process.exit(1);
  }
  const products = await admin.from("products").delete({ count: "exact" }).like("name", `${TAG} %`);
  if (products.error) {
    console.error(`clean failed: ${products.error.message}`);
    process.exit(1);
  }
  console.log(`Removed ${count} seeded clients and ${products.count} seeded products.`);
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
console.log(`Seeded ${made} products (named "${TAG} …"). Remove with --clean.`);
