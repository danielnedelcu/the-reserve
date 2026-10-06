import { z } from "zod";

/**
 * The URL as a table's state, checked (docs/design/server-tables-design.md,
 * decision 6). A page declares its filters and its sort keys once; this
 * turns `route.query` into a typed query where every value either passed
 * its check or became the default. Nothing here throws: a wrong value in
 * the address bar is a default, not an error page. The database function
 * re-checks the same vocabulary (22023 on an unknown sort or filter), so
 * the two sides agree by construction and `tests/shared/tablesUrl.test.ts`
 * holds this side to it.
 *
 * Keys: `q` (search text, ≤ 200 chars; a page may keep it out of the URL,
 * decision 5), `page` (1-based), `sort` (one of the page's keys; the first
 * is the default), `dir` (`asc` | `desc`), and one key per filter.
 */

/** A UUID, as the database writes them. */
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** A "YYYY-MM-DD" day key that is a real date (Date.parse would roll Feb 30 into March). */
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number) as [number, number, number];
    const at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  }, "not a real date");

/** One of a fixed vocabulary. */
export const oneOf = <const T extends readonly [string, ...string[]]>(...values: T) => z.enum(values);

export type FilterShape = Record<string, z.ZodType<string>>;

export interface TableQuerySpec<F extends FilterShape, S extends readonly [string, ...string[]]> {
  /** Each filter's check; a value that fails it is dropped. */
  filters: F;
  /** The sort keys the database function accepts; the first is the default. */
  sorts: S;
  /** The default direction when the URL does not say. Default: ascending. */
  defaultDesc?: boolean;
  /** The longest search text accepted. Default 200. */
  maxSearch?: number;
}

export interface TableQuery<F extends FilterShape, S extends readonly [string, ...string[]]> {
  q: string;
  page: number;
  sort: S[number];
  desc: boolean;
  filters: { [K in keyof F]?: z.infer<F[K]> };
}

/** The first string of a query value (`?a=1&a=2` gives "1"), trimmed; else "". */
export function firstValue(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim();
  return "";
}

/**
 * The checked query. Invalid or missing values become their defaults;
 * a filter that fails its check is absent. Never throws.
 */
export function parseTableQuery<F extends FilterShape, S extends readonly [string, ...string[]]>(
  spec: TableQuerySpec<F, S>,
  raw: Record<string, unknown>,
): TableQuery<F, S> {
  const q = z.string().max(spec.maxSearch ?? 200).catch("").parse(firstValue(raw.q).slice(0, spec.maxSearch ?? 200));
  const page = z.coerce.number().int().min(1).catch(1).parse(firstValue(raw.page) || "1");
  const sort = z.enum(spec.sorts).catch(spec.sorts[0]).parse(firstValue(raw.sort)) as S[number];
  const dirRaw = firstValue(raw.dir);
  const desc = dirRaw === "asc" ? false : dirRaw === "desc" ? true : (spec.defaultDesc ?? false);
  const filters: Record<string, string> = {};
  for (const [name, check] of Object.entries(spec.filters)) {
    const value = firstValue(raw[name]);
    if (!value) continue;
    const result = check.safeParse(value);
    if (result.success) filters[name] = result.data;
  }
  return { q, page, sort, desc, filters: filters as TableQuery<F, S>["filters"] };
}

/**
 * The URL query for a state: defaults are left out so the address stays
 * short (`page=1`, the default sort and direction, empty filters, empty
 * search). Keys the table does not own are kept as they were.
 */
export interface TableState<S extends readonly [string, ...string[]]> {
  q?: string;
  page?: number;
  sort?: S[number];
  desc?: boolean;
  /** A null or undefined value leaves that filter out. */
  filters?: Record<string, string | null | undefined>;
}

export function tableQueryToUrl<F extends FilterShape, S extends readonly [string, ...string[]]>(
  spec: TableQuerySpec<F, S>,
  state: TableState<S>,
  current: Record<string, unknown>,
  options: { includeSearch: boolean },
): Record<string, string> {
  const owned = new Set(["q", "page", "sort", "dir", ...Object.keys(spec.filters)]);
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (owned.has(k)) continue;
    const value = firstValue(v);
    if (value) next[k] = value;
  }
  if (options.includeSearch && state.q) next.q = state.q;
  if (state.page && state.page > 1) next.page = String(state.page);
  if (state.sort && state.sort !== spec.sorts[0]) next.sort = state.sort;
  const defaultDesc = spec.defaultDesc ?? false;
  if (state.desc !== undefined && state.desc !== defaultDesc) next.dir = state.desc ? "desc" : "asc";
  for (const [name, value] of Object.entries(state.filters ?? {})) {
    if (value) next[name] = value;
  }
  return next;
}
