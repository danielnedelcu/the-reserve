/**
 * Test cleanup for the append-only audit_log, LOCAL STACK ONLY.
 *
 * audit_log refuses UPDATE and DELETE for every role, the service role
 * included (append_only_block), and the staff_roles trigger writes a row
 * on every grant and revocation — so a test staff member cannot even be
 * deleted cleanly through the API: the cascade revokes their roles and
 * writes one more row AFTER any cleanup ran. This helper takes the whole
 * trace in ONE transaction with session_replication_role = replica
 * (triggers off): it revokes the staff members' roles silently, then
 * removes the audit rows they wrote (actor_staff_id) and the rows written
 * about them (entity_type 'staff', entity_id). The caller deletes the
 * staff rows afterwards through the API as before. Behind the localhost
 * guard: hosted runs never create staff or grant a role, so they never
 * need this (CLAUDE.md, docs/testing-design.md).
 */
import pg from "pg";
import { isLocalUrl, pgSsl, requireLocalStack } from "./_env.mjs";

export async function scrubTestStaff(dsn, staffIds) {
  const ids = (staffIds ?? []).filter(Boolean);
  if (!ids.length) return { roles: 0, audit: 0 };
  if (!dsn || !isLocalUrl(dsn)) {
    throw new Error("scrubTestStaff: the direct connection must be the LOCAL stack (append-only rows are never removed elsewhere)");
  }
  const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const roles = await c.query("delete from staff_roles where staff_id = any($1::uuid[])", [ids]);
    const audit = await c.query(
      "delete from audit_log where actor_staff_id = any($1::uuid[]) or (entity_type = 'staff' and entity_id = any($1::uuid[]))",
      [ids],
    );
    await c.query("commit");
    return { roles: roles.rowCount, audit: audit.rowCount };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

/**
 * Remove a TEST ORGANISATION and every row that belongs to it, LOCAL STACK
 * ONLY (docs/testing-design.md, "The money journeys"). The ledger and the
 * audit log are append-only for every role and every key out of the
 * ledger is `restrict`, so a journey that rang up a sale cannot be cleaned
 * through the API at all: the rows go in ONE transaction on the direct
 * connection with session_replication_role = replica, which turns off
 * every trigger — the append-only block and the foreign-key checks (they
 * are internal triggers) alike. Nothing cascades, so the lists are built
 * from the catalog, not by hand:
 *
 *   - the organisation-scoped tables are every public table with an
 *     organization_id column (information_schema);
 *   - a table WITHOUT the column is reached through its foreign keys
 *     (pg_constraint): its rows are "in the organisation" when a parent
 *     row is, recursively, and the deepest tables go first so a parent is
 *     still there to be matched;
 *   - afterwards, with the triggers back on, two checks that would be
 *     silent otherwise: zero rows carry the id in any scoped table, and
 *     no foreign key anywhere has a child row whose parent is gone.
 *
 * A table added later is covered without editing this function. Returns
 * the per-table counts. Auth users are the caller's (admin API).
 */
export async function removeTestOrganisation(dsn, orgId) {
  requireLocalStack("removeTestOrganisation (deletes every row of a test organisation)", [dsn]);
  if (!orgId) throw new Error("removeTestOrganisation: no organisation id");
  const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
  await c.connect();
  const q = (text, params) => c.query(text, params);
  const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';
  try {
    const scoped = (await q(`
      select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'organization_id' and c.table_name <> 'organizations'
      order by 1`)).rows.map((r) => r.table_name);
    const scopedSet = new Set(scoped);
    // Every foreign key in public: child, parent, and the paired column lists.
    const fks = (await q(`
      select con.conname,
             child.relname  as child,  (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey)  with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid  and a.attnum = k.attnum)::text[] as child_cols,
             parent.relname as parent, (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)::text[] as parent_cols
      from pg_constraint con
      join pg_class child  on child.oid  = con.conrelid
      join pg_class parent on parent.oid = con.confrelid
      where con.contype = 'f' and con.connamespace = 'public'::regnamespace and parent.relnamespace = 'public'::regnamespace`)).rows;
    // "In the organisation" predicate for any public table, through its keys.
    const predicate = (table, depth = 0) => {
      if (table === "organizations") return "id = $1";
      if (scopedSet.has(table)) return "organization_id = $1";
      if (depth > 6) return null;
      const parts = [];
      for (const fk of fks) {
        if (fk.child !== table || fk.parent === table) continue;
        const inner = predicate(fk.parent, depth + 1);
        if (!inner) continue;
        parts.push(`(${fk.child_cols.map(ident).join(", ")}) in (select ${fk.parent_cols.map(ident).join(", ")} from ${ident(fk.parent)} where ${inner})`);
      }
      return parts.length ? parts.join(" or ") : null;
    };
    // Depth: a scoped table is 0; an unscoped table is 1 + the deepest parent it is reached through.
    const depthOf = (table, seen = new Set()) => {
      if (table === "organizations" || scopedSet.has(table)) return 0;
      if (seen.has(table)) return 0;
      seen.add(table);
      let d = -1;
      for (const fk of fks) if (fk.child === table && fk.parent !== table) d = Math.max(d, depthOf(fk.parent, seen));
      return d < 0 ? -1 : d + 1;
    };
    const unscoped = (await q(`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name not in (select table_name from information_schema.columns where table_schema = 'public' and column_name = 'organization_id')
        and table_name <> 'organizations'`)).rows.map((r) => r.table_name)
      .map((t) => ({ t, depth: depthOf(t), where: predicate(t) }))
      .filter((x) => x.depth > 0 && x.where)
      .sort((a, b) => b.depth - a.depth);
    const removed = {};
    await q("begin");
    await q("set local session_replication_role = replica");
    for (const { t, where } of unscoped) removed[t] = (await q(`delete from ${ident(t)} where ${where}`, [orgId])).rowCount;
    for (const t of scoped) removed[t] = (await q(`delete from ${ident(t)} where organization_id = $1`, [orgId])).rowCount;
    removed.organizations = (await q("delete from organizations where id = $1", [orgId])).rowCount;
    await q("commit");
    // The checks, triggers back on, outside the transaction.
    const problems = [];
    for (const t of scoped) {
      const { rows } = await q(`select count(*)::int as n from ${ident(t)} where organization_id = $1`, [orgId]);
      if (rows[0].n) problems.push(`${t}: ${rows[0].n} row(s) still carry the organisation`);
    }
    for (const fk of fks) {
      const notNull = fk.child_cols.map((col) => `${ident(col)} is not null`).join(" and ");
      const match = fk.child_cols.map((col, i) => `p.${ident(fk.parent_cols[i])} = c.${ident(col)}`).join(" and ");
      const { rows } = await q(`select count(*)::int as n from ${ident(fk.child)} c where ${notNull} and not exists (select 1 from ${ident(fk.parent)} p where ${match})`);
      if (rows[0].n) problems.push(`${fk.conname}: ${rows[0].n} ${fk.child} row(s) whose ${fk.parent} parent is gone`);
    }
    if (problems.length) throw new Error(`removeTestOrganisation left rows behind:\n  ${problems.join("\n  ")}`);
    return removed;
  } catch (e) {
    await q("rollback").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
