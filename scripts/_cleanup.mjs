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
import { isLocalUrl, pgSsl } from "./_env.mjs";

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
