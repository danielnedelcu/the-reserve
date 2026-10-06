/**
 * Load seed for the server-side tables benchmark (docs/design/server-tables-design.md,
 * decision 7). Puts 10,000 clients into the seeded organisation on the
 * LOCAL stack — never anywhere else: it refuses to run without
 * SUPABASE_LOCAL=true and the localhost guard. Rows are tagged
 * referral_source = 'LOAD-SEED'; `--clean` removes them.
 *
 *   npm run seed:tables            seed 10,000 (or N with --count N)
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
  console.log(`Removed ${count} seeded clients.`);
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
console.log(`\nSeeded ${inserted} clients into "${org.data.name}" (tagged ${TAG}). Remove with --clean.`);
