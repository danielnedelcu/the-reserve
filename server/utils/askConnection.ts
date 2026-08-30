import pg from "pg";

/**
 * Ask The Reserve — the ask_readonly connection.
 *
 * This is the safety boundary, and the reason it is a separate
 * connection rather than a role switch on the app's own session:
 * **the session user is the leash**. Here session_user IS ask_readonly,
 * so there is no privileged role for generated SQL to climb back to —
 * `set_config('role', ...)` fails because ask_readonly holds no
 * memberships at all.
 *
 * The rejected design ran `set local role ask_readonly` inside a
 * function on the normal PostgREST connection. That is broken: there
 * the session user is `authenticator`, a member of anon, authenticated
 * AND service_role, so role-change privilege is checked against a role
 * that can reach service_role. Never role-switch within a privileged
 * session.
 *
 * RLS still applies. `request.jwt.claims` is session state rather than
 * role state, so setting it here makes auth.uid() → current_staff_id()
 * → current_org_id() resolve to the asking admin, and every existing
 * policy scopes results to their organization and permissions.
 */

const ROW_LIMIT_MAX = 500;

let pool: pg.Pool | null = null;

/**
 * The fail-closed guard, as a pure predicate over the connection string.
 *
 * With no ASK_DATABASE_URL there is no ask_readonly connection, and so no
 * safety boundary — an ask must be refused outright rather than fall back
 * to anything. Split from the runtime-config read below so this can be
 * tested without a Nuxt context.
 */
export function assertConnectionString(
  value: string | undefined | null,
): asserts value is string {
  if (!value) {
    throw createError({
      statusCode: 503,
      statusMessage: "Ask is not configured on this server (no query connection).",
    });
  }
}

/**
 * Fails closed when the ask connection is not configured.
 *
 * Call this BEFORE anything that costs money. The connection is needed by
 * both the preset and free-text paths, so checking it up front means an
 * unconfigured server never spends an Anthropic call only to 503 after.
 */
export function assertAskConfigured(): void {
  assertConnectionString(useRuntimeConfig().askDatabaseUrl);
}

/**
 * One pool for the process. Sized under the role's `connection limit 5`
 * so a burst of asks queues rather than erroring at the server.
 */
function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = useRuntimeConfig().askDatabaseUrl;
  assertConnectionString(connectionString);

  pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Supabase terminates TLS with its own CA; the pooler hostname is
    // what we connect to, so verification is left to the platform.
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

/**
 * Statement-shape checks. These are NOT the security boundary — the role
 * is. They exist so a malformed generation fails with a clear message
 * instead of a confusing partial execution, and so the row-cap wrapper
 * below has a single expression to wrap.
 */
export function assertSingleSelect(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw createError({ statusCode: 400, statusMessage: "No query to run." });
  }
  // Strip trailing semicolons, then reject any that remain. A semicolon
  // inside a string literal trips this too; that false positive is an
  // acceptable trade for a check this simple, since it is not the boundary.
  const withoutTrailing = trimmed.replace(/;+\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw createError({
      statusCode: 400,
      statusMessage: "Only a single statement may be run.",
    });
  }
  if (!/^(select|with)\s/i.test(withoutTrailing)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Only SELECT queries may be run.",
    });
  }
  return withoutTrailing;
}

/**
 * Postgres type OID for int8 (bigint). node-postgres hands int8 back as a
 * STRING to avoid silent precision loss, and any aggregate over an integer
 * column — every `sum(..._cents)` and `count(*)` here — is widened to int8
 * by Postgres. Left alone, a money sum arrives as "35641" and the display
 * layer's numeric formatting never fires, so the cell shows raw cents.
 */
const INT8_OID = 20;

/**
 * Postgres type OID for `date` (a calendar day, no time). node-postgres
 * parses it into a JS Date at the SERVER's local midnight, so a plain day
 * crosses the wire as e.g. "2026-08-11T05:00:00.000Z" — which renders a
 * spurious "12:00 AM", and drifts to the previous day for any viewer west
 * of the server. Reduced to a bare YYYY-MM-DD string so it stays the
 * calendar day it always was.
 */
const DATE_OID = 1082;

/**
 * Coerce int8 columns to JS numbers so the route's JSON contract can promise
 * that a numeric column arrives as a number.
 *
 * Deliberately int8 ONLY. numeric (OID 1700) is left as a string: it can
 * carry real decimals and magnitudes past 2^53, so coercing it would trade a
 * visible formatting bug for an invisible precision one. The display layer
 * accepts numeric strings, which is the correct home for that case.
 *
 * A value past Number.MAX_SAFE_INTEGER is also left as a string for the same
 * reason — better a raw digit string than a quietly wrong total.
 */
export function coerceRows(
  fields: { name: string; dataTypeID: number }[],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const int8 = fields.filter((f) => f.dataTypeID === INT8_OID).map((f) => f.name);
  const dates = fields.filter((f) => f.dataTypeID === DATE_OID).map((f) => f.name);
  if (!int8.length && !dates.length) return rows;

  const pad = (n: number) => String(n).padStart(2, "0");

  return rows.map((row) => {
    const out = { ...row };
    for (const column of int8) {
      const value = out[column];
      if (typeof value !== "string" || value === "") continue;
      const n = Number(value);
      if (Number.isSafeInteger(n)) out[column] = n;
    }
    for (const column of dates) {
      const value = out[column];
      // Local getters on purpose: the driver built this Date at local
      // midnight, so they yield the calendar day that was actually stored.
      if (value instanceof Date) {
        out[column] =
          `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
      }
    }
    return out;
  });
}

export interface AskExecution {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * Runs one generated SELECT as ask_readonly, with the asking admin's
 * identity in scope so RLS narrows the result to what they may see.
 *
 * @param sql    the statement, already shape-checked
 * @param userId the asking admin's auth.users id — becomes the `sub`
 *               claim, which is what auth.uid() reads
 */
export async function executeAskQuery(
  sql: string,
  userId: string,
  limit = ROW_LIMIT_MAX,
): Promise<AskExecution> {
  const statement = assertSingleSelect(sql);
  const cap = Math.min(Math.max(1, Math.trunc(limit)), ROW_LIMIT_MAX);

  // Without an identity the claims carry no `sub`, auth.uid() is null, and
  // every RLS policy denies — which looks exactly like "no rows matched"
  // rather than a fault. Refuse instead: a wrong answer that reads as a
  // real answer is worse than an error.
  if (!userId) {
    throw createError({
      statusCode: 500,
      statusMessage: "Refusing to run a query with no caller identity.",
    });
  }

  const client = await getPool().connect();
  try {
    // Explicit read-only transaction. The role already defaults to this;
    // stating it here means the guarantee does not depend on the role's
    // settings having been applied to this particular connection.
    await client.query("begin read only");

    // Transaction-local (is_local = true), so it cannot leak to the next
    // borrower of this pooled connection.
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);

    // The row cap, applied as a wrapper rather than trusted to the
    // generated SQL. One extra row is fetched to detect truncation.
    const result = await client.query(
      `select * from (${statement}) as generated limit ${cap + 1}`,
    );

    await client.query("commit");

    const truncated = result.rows.length > cap;
    const page = (truncated ? result.rows.slice(0, cap) : result.rows) as Record<
      string,
      unknown
    >[];
    const rows = coerceRows(result.fields, page);

    return {
      columns: result.fields.map((field) => field.name),
      rows,
      truncated,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
