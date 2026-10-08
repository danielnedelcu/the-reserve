/**
 * schema-compare — the shape of the public schema on two databases, and
 * the difference. The "zero differences" check that follows every hosted
 * push (hosted versus a local stack built from the migrations), moved
 * into the repo so it covers what it claims to.
 *
 * Covered: extensions; tables and VIEWS by column list; constraints;
 * indexes; policies (command, roles, qual, with check); triggers;
 * functions (full definition); views (definition through pg_get_viewdef,
 * options — security_invoker, security_barrier, check_option — and
 * owner); grants on tables, sequences and views; function grants;
 * default privileges; cron jobs; publication tables.
 *
 * Views were added 2026-10-08: every "zero differences" result before
 * then compared view COLUMNS only (through information_schema), not the
 * definition or its options, so a view whose security_invoker had been
 * lost or whose body differed would have passed. Proven non-vacuous on
 * the day: with ledger_lines' security_invoker reset locally the compare
 * reported the view, and again with its definition altered.
 *
 *   node scripts/schema-compare.mjs                 hosted (TBLS_DSN in apps/reserve/.env) vs local (DB_URL); exit 1 on any difference
 *   SCHEMA_DSN=... node scripts/schema-compare.mjs dump > a.json
 *   node scripts/schema-compare.mjs diff a.json b.json [labelA labelB]
 *
 * Connection strings come from the environment, never argv, so an error
 * never echoes one.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { get, isLocalUrl, pgSsl } from "./_env.mjs";

export async function dumpSchema(dsn) {
  const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
  await c.connect();
  const out = {};
  const put = (kind, name, value) => { out[`${kind}:${name}`] = value; };
  try {
    for (const r of (await c.query(`select extname, extnamespace::regnamespace::text ns from pg_extension order by 1`)).rows) put("extension", r.extname, r.ns);
    for (const r of (await c.query(`select table_name t, string_agg(column_name || ' ' || data_type || case when is_nullable='NO' then ' not null' else '' end || coalesce(' default ' || column_default, ''), ', ' order by ordinal_position) cols from information_schema.columns where table_schema='public' group by 1`)).rows) put("table", r.t, r.cols);
    for (const r of (await c.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) def from pg_constraint where connamespace='public'::regnamespace order by 1,2`)).rows) put("constraint", `${r.t}.${r.conname}`, r.def);
    for (const r of (await c.query(`select tablename t, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`)).rows) put("index", `${r.t}.${r.indexname}`, r.indexdef);
    for (const r of (await c.query(`select tablename t, policyname, cmd, permissive, roles::text, qual, with_check from pg_policies where schemaname='public' order by 1,2`)).rows) put("policy", `${r.t}.${r.policyname}`, [r.cmd, r.permissive, r.roles, r.qual, r.with_check]);
    for (const r of (await c.query(`select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) def, tgenabled from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace) order by 1,2`)).rows) put("trigger", `${r.t}.${r.tgname}`, [r.def, r.tgenabled]);
    for (const r of (await c.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name, pg_get_functiondef(p.oid) def from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' order by 1`)).rows) put("function", r.name, r.def);
    // Views: the definition, the options (security_invoker, security_barrier, check_option) and the owner.
    for (const r of (await c.query(`select c.relname, c.relkind, pg_get_viewdef(c.oid, true) def, coalesce(c.reloptions, '{}') options, c.relowner::regrole::text owner from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('v','m') order by 1`)).rows) put("view", r.relname, { kind: r.relkind, def: r.def, options: [...r.options].sort(), owner: r.owner });
    for (const r of (await c.query(`select c.relkind kind, c.relname name, a.grantee::regrole::text grantee, string_agg(a.privilege_type, ',' order by a.privilege_type) privs from pg_class c left join lateral aclexplode(c.relacl) a on true where c.relnamespace='public'::regnamespace and c.relkind in ('r','S','v','m') and a.grantee is not null group by 1,2,3 order by 1,2,3`)).rows) put("grant", `${r.kind}:${r.name}:${r.grantee}`, r.privs);
    for (const r of (await c.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name, case when p.proacl is null then 'PUBLIC(default)' else coalesce(a.grantee::regrole::text,'PUBLIC') end grantee, string_agg(coalesce(a.privilege_type,'EXECUTE'), ',' order by a.privilege_type) privs from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.pronamespace='public'::regnamespace group by 1,2 order by 1,2`)).rows) put("fngrant", `${r.name}:${r.grantee}`, r.privs);
    for (const r of (await c.query(`select defaclrole::regrole::text role, defaclobjtype t, defaclacl::text acl from pg_default_acl where defaclnamespace='public'::regnamespace order by 1,2`)).rows) put("defacl", `${r.role}:${r.t}`, r.acl);
    try { for (const r of (await c.query(`select jobname, schedule, command from cron.job order by 1`)).rows) put("cron", r.jobname, [r.schedule, r.command]); } catch { put("cron", "(none)", "no cron schema"); }
    for (const r of (await c.query(`select pubname, tablename from pg_publication_tables where schemaname='public' order by 1,2`)).rows) put("publication", `${r.pubname}.${r.tablename}`, true);
  } finally {
    await c.end();
  }
  return out;
}

export function diffSchemas(a, b, labelA = "A", labelB = "B") {
  const lines = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const va = JSON.stringify(a[k]), vb = JSON.stringify(b[k]);
    if (va === vb) continue;
    lines.push(!(k in a) ? `ONLY ${labelB.padEnd(7)} ${k}` : !(k in b) ? `ONLY ${labelA.padEnd(7)} ${k}` : `DIFFERS      ${k}`);
  }
  return lines;
}

const mode = process.argv[2] ?? "compare";
if (mode === "dump") {
  const dsn = process.env.SCHEMA_DSN;
  if (!dsn) { console.error("SCHEMA_DSN is not set"); process.exit(2); }
  console.log(JSON.stringify(await dumpSchema(dsn)));
} else if (mode === "diff") {
  const [fa, fb, la = "A", lb = "B"] = process.argv.slice(3);
  const a = JSON.parse(readFileSync(fa, "utf8")), b = JSON.parse(readFileSync(fb, "utf8"));
  const lines = diffSchemas(a, b, la, lb);
  for (const l of lines) console.log(l);
  const views = Object.keys(a).filter((k) => k.startsWith("view:")).length;
  console.log(`\n${lines.length} difference(s) (${la}: ${Object.keys(a).length} objects, ${lb}: ${Object.keys(b).length}; ${views} view(s) compared by definition and options)`);
  process.exit(lines.length ? 1 : 0);
} else if (mode === "compare") {
  // Hosted from the app's .env (TBLS_DSN, the postgres role), local from the exported stack env (DB_URL).
  const hosted = process.env.HOSTED_DSN ?? get("TBLS_DSN");
  const local = process.env.DB_URL ?? process.env.DATABASE_URL;
  if (!hosted || !local) { console.error("compare needs TBLS_DSN (apps/reserve/.env or HOSTED_DSN) and the local stack's DB_URL exported"); process.exit(2); }
  if (!isLocalUrl(local)) { console.error("the local side must be the local stack"); process.exit(2); }
  if (isLocalUrl(hosted)) { console.error("the hosted side resolved to a local URL; nothing to compare"); process.exit(2); }
  const [a, b] = await Promise.all([dumpSchema(hosted), dumpSchema(local)]);
  const lines = diffSchemas(a, b, "HOSTED", "LOCAL");
  for (const l of lines) console.log(l);
  const views = Object.keys(a).filter((k) => k.startsWith("view:")).length;
  console.log(`\n${lines.length} difference(s) (hosted: ${Object.keys(a).length} objects, local: ${Object.keys(b).length}; ${views} view(s) compared by definition and options)`);
  process.exit(lines.length ? 1 : 0);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
