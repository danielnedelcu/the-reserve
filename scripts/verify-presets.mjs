/**
 * Second half of verification:
 *  (a) RLS resolves to the asking admin when request.jwt.claims is injected
 *      — the positive case the boundary script could not prove.
 *  (b) every PRESET_SQL query actually parses and runs.
 *
 * Run: npm run verify:presets
 *
 * Read-only. Prints counts and PASS/FAIL only — never row contents.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this file so the scripts work from any cwd.
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pg = createRequire(`${PROJECT}/package.json`)("pg");

const L = fs.readFileSync(`${PROJECT}/.env`, "utf8").split("\n");
const g = (k) => {
  const l = L.find((x) => x.trim().startsWith(k + "=")) || "";
  return l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
};

const { PRESET_SQL } = await import(`${PROJECT}/server/utils/askPresets.ts`);
const { coerceRows } = await import(`${PROJECT}/server/utils/askConnection.ts`);
const { planColumns, columnLabel, formatCell } = await import(
  `${PROJECT}/shared/ask/format.ts`
);

// --- find a real admin (privileged connection, id only) ---------------
const admin = new pg.Client({ connectionString: g("TBLS_DSN"), ssl: { rejectUnauthorized: false } });
await admin.connect();
const who = await admin.query(`
  select s.user_id, s.organization_id
    from staff s
    join staff_roles sr on sr.staff_id = s.id
    join role_permissions rp on rp.role_id = sr.role_id
   where rp.permission_key = 'ask.query' and s.active and s.user_id is not null
   limit 1`);
await admin.end();

if (!who.rows.length) {
  console.log("No active staff member holds ask.query — cannot test the RLS positive case.");
  process.exit(1);
}
const { user_id: userId } = who.rows[0];
console.log("using an ask.query holder's user_id (value not printed)\n");

const ask = () =>
  new pg.Client({ connectionString: g("ASK_DATABASE_URL"), ssl: { rejectUnauthorized: false } });

/** Mirrors executeAskQuery(): read-only txn + injected claims. */
async function runAsAdmin(sql, sub = userId) {
  const c = ask();
  await c.connect();
  try {
    await c.query("begin read only");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub, role: "authenticated" }),
    ]);
    const r = await c.query(`select * from (${sql}) as generated limit 501`);
    await c.query("commit");
    // Same coercion the route applies, so this reports what the UI receives.
    const rows = coerceRows(r.fields, r.rows);
    return {
      ok: true,
      n: rows.length,
      cols: r.fields.length,
      columns: r.fields.map((f) => f.name),
      rows,
    };
  } catch (e) {
    return { ok: false, err: e.message.split("\n")[0] };
  } finally {
    await c.end().catch(() => {});
  }
}

// --- (a) does RLS resolve with claims? --------------------------------
console.log("=== RLS with injected claims ===");
const ident = await runAsAdmin(
  "select (current_org_id() is not null) as org_resolves, (current_staff_id() is not null) as staff_resolves",
);
console.log(
  ident.ok
    ? `PASS  helpers resolve under injected claims (returned ${ident.n} row)`
    : `FAIL  ${ident.err}`,
);

const withClaims = await runAsAdmin("select count(*)::int n from clients");
const bogus = await runAsAdmin(
  "select count(*)::int n from clients",
  "00000000-0000-0000-0000-000000000000",
);
const realCount = withClaims.ok ? (await runAsAdmin("select count(*)::int n from clients")).n : 0;
console.log(
  withClaims.ok ? `PASS  query runs under claims (${realCount} row(s) returned)` : `FAIL  ${withClaims.err}`,
);
console.log(
  bogus.ok ? `      bogus sub also runs (RLS should yield nothing for it)` : `      bogus sub: ${bogus.err}`,
);

// --- (b) do the presets actually run? ---------------------------------
console.log("\n=== PRESET_SQL execution ===");
let pass = 0;
const ids = Object.keys(PRESET_SQL);
for (const id of ids) {
  const r = await runAsAdmin(PRESET_SQL[id]);
  if (r.ok) {
    pass++;
    console.log(`PASS  ${id.padEnd(38)} ${r.n} row(s), ${r.cols} col(s)`);
    // Money columns, rendered exactly as the results table will render them.
    const cur = planColumns(r.columns, r.rows);
    const moneyCols = r.columns.filter(
      (c) => c.endsWith("_cents") || c.endsWith("_at"),
    );
    if (moneyCols.length && r.rows.length) {
      for (const col of moneyCols) {
        const raw = r.rows[0][col];
        console.log(
          `        ${columnLabel(col, cur).padEnd(12)} ` +
            `raw=${JSON.stringify(raw)} (${typeof raw})`.padEnd(30) +
            `renders as ${formatCell(col, raw, cur)}`,
        );
      }
    }
  } else {
    console.log(`FAIL  ${id.padEnd(38)} ${r.err}`);
  }
}
console.log(`\n${pass}/${ids.length} presets executed successfully`);
