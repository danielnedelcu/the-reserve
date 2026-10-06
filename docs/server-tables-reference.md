# Server-side tables reference — how Lokl does it

Read 2026-10-06 from `~/turbo` (the Lokl marketplace, HEAD `009afe9`,
2026-10-04), as the foundation for The Reserve's server-side tables
design (`docs/design/server-tables-design.md`). Read-only: nothing in
either repo was changed to produce this. Lokl and The Reserve share no
accounts, keys or code; this document copies SHAPES, never values.

Lokl's admin app had tables that loaded every row into the browser
(bookings capped at 1,000, so older ones and their "needs attention"
counts were silently missed). On 2026-10-03 (commit `1e7fabe`, "Server-side
search, filters and pages for the admin tables") it moved four tables —
Bookings, Experiences, Services, Providers — onto one pattern: the URL
holds the table state, one composable drives it, ui-thing's TanStack table
runs in its manual modes, and one Postgres function per table does the
searching, filtering, sorting, counting and paging. At 10,000 bookings a
page takes 1–36ms in the database (`docs/decisions.md`).

Five things the brief for this reading assumed turn out NOT to be how
Lokl does it, and they shape what The Reserve should copy:

| Assumed | Actual |
| --- | --- |
| Zod URL schemas | Three hand-written predicates (`isUuid`, `isDay`, `oneOf`) plus inline coercion inside the composable; zod is used for forms, not table URLs |
| A server route between page and database | None. The admin app is an SPA (`ssr: false`); pages call `supabase.rpc("admin_*_page", …)` straight from the browser with the user's JWT, and the function enforces access |
| `useFetch` / `useAsyncData` in the table path | None. The composable takes a `load(query, signal)` callback; each page supplies its own RPC call |
| TanStack `manualFiltering` | Not used. Only `manualPagination` and `manualSorting`; search and filters live OUTSIDE TanStack, in form controls above the table that write to the URL |
| `pg_trgm` similarity search | Plain `ILIKE '%word%'` per word. The trigram GIN indexes exist only to make those "contains" searches fast; no `similarity()`, no threshold, no tsvector |

## 1. Where the pieces live

| Piece | Path (under `~/turbo`) | Reached by |
| --- | --- | --- |
| `useServerTable`, `asServerPage`, `isUuid`, `isDay`, `oneOf` | `apps/admin/app/composables/useServerTable.ts` (124 lines) | Nuxt auto-import |
| `useProviderPicker` | `apps/admin/app/composables/useProviderPicker.ts` | auto-import |
| `ServerTable` | `apps/admin/app/components/ServerTable.vue` (49 lines) | auto-import |
| `TableSearch` (the 300ms debounce) | `apps/admin/app/components/TableSearch.vue` | auto-import |
| `UiTanStackTable` (ui-thing, Lokl-modified) | `packages/ui/app/components/Ui/TanStackTable.vue` (833 lines) | the `@repo/ui` layer |
| `SearchSelect` (server-searched combobox) | `packages/ui/app/components/SearchSelect.vue` | the layer |
| Page functions, indexes, extension | `supabase/migrations/20261003072758_admin_search_pages.sql`, then `…161858_admin_booking_totals.sql`, `…20261004043455_admin_dashboard.sql`, `…193319_reviews.sql` | migrations |
| pgTAP proof | `supabase/tests/admin_search_pages.test.sql` (`plan(49)`), `admin_dashboard.test.sql`, `reviews.test.sql` | `npm run db:test` |
| Load seed + benchmark | `scripts/seed-admin-load.mjs`, `scripts/bench-admin-search.mjs` | by hand, local stack only |

Versions: Nuxt 4.5.2, `@tanstack/vue-table` 9.2.4 (the v9 API:
`useTable`, `tableFeatures({...})`, `table.atoms.pagination.get()`),
`@supabase/supabase-js` 2.117.2, zod 4.6.5. The Reserve is on the same
TanStack major (its `UiTanStackTable` already carries the v9 hydration
note), so the component-level changes transfer.

Consumers: `pages/bookings/index.vue`, `pages/providers.vue`,
`components/ListingsTable.vue` (Experiences and Services), and
`pages/content/index.vue` (guides), which uses the composable with a plain
PostgREST query and no page function because "the guides table is small
enough not to need a page function".

## 2. `useServerTable()` — the URL is the state

The whole composable, verbatim, because every later decision is in it:

```ts
// One pattern for the admin's server-side tables (Bookings, Experiences,
// Services, Providers; planned 2026-10-03). The search text, filters, page
// and sort live in the URL, so back, reload and bookmarks work; the page asks
// the database for one page of rows plus the total.
//
// - Values in the URL are checked; anything that doesn't make sense is
//   ignored, not trusted.
// - Changing a filter, the sort or the page adds a history entry; typing in
//   the search box replaces the current one (Back doesn't replay keystrokes).
//   Anything but the page itself goes back to page 1.
// - Each request carries an AbortSignal: a newer request cancels the older
//   one, and a late answer never overwrites a newer one.

export interface ServerPage<Row> {
  rows: Row[];
  total: number;
  /** False once a table switches to an estimated total ("About 12,400"). */
  total_exact: boolean;
}

export interface ServerTableQuery<F extends string> {
  q: string;
  filters: Partial<Record<F, string>>;
  page: number;
  sort: string;
  desc: boolean;
}

export interface ServerTableOptions<F extends string, Row> {
  /** The filters this table has, each with its check (return the value if it's acceptable). */
  filters: Record<F, (value: string) => boolean>;
  /** Server sort keys this table accepts; the first is the default. */
  sorts: readonly string[];
  defaultDesc?: boolean;
  load: (query: ServerTableQuery<F>, signal: AbortSignal) => Promise<ServerPage<Row>>;
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const oneOf = (...values: string[]) => (v: string) => values.includes(v);

export function useServerTable<F extends string, Row>(opts: ServerTableOptions<F, Row>) {
  const route = useRoute();
  const router = useRouter();
  const one = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

  // The URL, checked.
  const query = computed<ServerTableQuery<F>>(() => {
    const q = route.query;
    const filters: Partial<Record<F, string>> = {};
    for (const [name, ok] of Object.entries(opts.filters) as [F, (v: string) => boolean][]) {
      const value = one(q[name]).trim();
      if (value && ok(value)) filters[name] = value;
    }
    const page = Number.parseInt(one(q.page), 10);
    const sort = one(q.sort);
    return {
      q: one(q.q).slice(0, 200),
      filters,
      page: Number.isInteger(page) && page > 0 ? page : 1,
      sort: opts.sorts.includes(sort) ? sort : opts.sorts[0]!,
      desc: one(q.dir) === "asc" ? false : one(q.dir) === "desc" ? true : (opts.defaultDesc ?? true),
    };
  });

  function go(changes: Record<string, string | number | null | undefined>, history: "push" | "replace" = "push") {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...route.query, ...changes })) {
      const value = one(v as unknown) || (typeof v === "number" ? String(v) : "");
      if (value) next[k] = value;
    }
    // Page 1 is the default: keep the address short.
    if (next.page === "1") delete next.page;
    return history === "push" ? router.push({ query: next }) : router.replace({ query: next });
  }

  const setFilter = (name: F, value: string | null | undefined) => go({ [name]: value ?? null, page: null });
  const setFilters = (values: Partial<Record<F, string | null>>) => go({ ...values, page: null });
  const setSearch = (q: string) => go({ q: q.trim() || null, page: null }, "replace");
  const setPage = (page: number) => go({ page });
  const setSort = (sort: string, desc: boolean) => go({ sort, dir: desc ? "desc" : "asc", page: null });
  const clear = () => router.push({ query: {} });

  // Loading: the newest request wins.
  const rows = shallowRef<Row[]>([]);
  const total = ref(0);
  const totalExact = ref(true);
  const pending = ref(true);
  const error = ref<unknown>(null);
  let controller: AbortController | null = null;

  async function load() {
    controller?.abort();
    const mine = (controller = new AbortController());
    pending.value = true;
    try {
      const page = await opts.load(query.value, mine.signal);
      if (mine.signal.aborted) return;
      rows.value = page.rows;
      total.value = page.total;
      totalExact.value = page.total_exact;
      error.value = null;
    } catch (e) {
      if (mine.signal.aborted) return;
      error.value = e;
      reportProblem("Couldn't load the table", e);
    } finally {
      if (!mine.signal.aborted) pending.value = false;
    }
  }
  watch(() => JSON.stringify(query.value), () => void load(), { immediate: true });
  onBeforeUnmount(() => controller?.abort());

  const filtering = computed(() => !!(query.value.q || Object.keys(query.value.filters).length));

  return { query, rows, total, totalExact, pending, error, setFilter, setFilters, setSearch, setPage, setSort, clear, refresh: load, filtering };
}

/** A database page function's answer as a ServerPage, or throw its error. */
export function asServerPage<Row>(data: unknown, error: { message: string } | null): ServerPage<Row> {
  if (error) throw error;
  const page = data as Partial<ServerPage<Row>> | null;
  return { rows: page?.rows ?? [], total: page?.total ?? 0, total_exact: page?.total_exact ?? true };
}
```

The rules it encodes:

| Rule | How |
| --- | --- |
| URL keys | `q` (cut to 200 chars), `page` (1-based; the key is dropped when it is 1), `sort` (must be in `opts.sorts`; the first is the default), `dir` (`asc`/`desc`; else `defaultDesc ?? true`), one key per declared filter |
| Validation | A filter value survives only if non-empty after trimming AND its predicate passes. Repeated keys take the first value. Anything invalid is dropped silently and replaced by the default: no error, no URL rewrite. Unknown keys stay in the URL (`go()` spreads `route.query`) but are ignored |
| History | `router.push` for filters, sort, page and `clear`; `router.replace` for search only, so Back never replays keystrokes |
| Page reset | every setter except `setPage` sends `page: null` |
| Fetch | `watch(JSON.stringify(query))` with `immediate: true`; one `AbortController` per request, the previous aborted; `pending` stays true until the NEWEST request settles; a late answer never overwrites a newer one |
| Debounce | NOT here. `TableSearch.vue` waits 300ms after typing stops, then emits `search`; the composable cancels any request still running |
| TanStack | the composable knows nothing about TanStack; `ServerTable` translates page/sort both ways |

A consumer is small. Providers, `pages/providers.vue`:

```ts
const table = useServerTable({
  filters: { status: oneOf("active", "suspended"), payouts: oneOf("not_started", "in_progress", "ready", "not_ready"), city: isUuid, paid_since: isDay },
  sorts: ["joined", "name", "city", "payouts", "status"],
  async load({ q, filters, page, sort, desc }, signal) {
    const { data, error } = await supabase
      .rpc("admin_providers_page", { p_q: q || undefined, p_status: filters.status, p_payout_setup: filters.payouts, p_city_id: filters.city, p_paid_since: filters.paid_since, p_sort: sort, p_desc: desc, p_page: page })
      .abortSignal(signal);
    return asServerPage<ProviderRow>(data, error);
  },
});
```

Bookings adds a date range as two filters (`from`/`to`, each `isDay`) exposed
as one computed `dateRange` whose setter calls `table.setFilters({ from, to })`,
and reads `totals` off the same RPC answer (`totals.value = data?.totals`) —
the money across every match, not the page.

Columns map to server sort keys through `meta.sortKey`:

```ts
const columns = [
  { id: "booking", header: "Booking", meta: { sortKey: "listing" } },
  { id: "when", header: "When", meta: { sortKey: "when" } },
  { accessorKey: "status", header: "Status", meta: { sortKey: "status" } },
  { id: "charged", header: "Charged", meta: { sortKey: "charged", class: { th: "text-right", td: "text-right" } } },
  { id: "payout", header: "Payout" },   // no sortKey: not sortable
];
```

Template states, in order: a count line with `aria-live="polite"`
("About " prefix when `totalExact` is false); a "Clear filters" link when
`filtering`; a destructive `UiAlert` on `error`; an `EmptyState` when
`!pending && !total`, with different text when filters are on ("No X
yet" versus "No X match these filters"); otherwise the `ServerTable`. The
filter `<form>` has `role="search"` and `@submit.prevent`.

## 3. `ServerTable` — TanStack in manual mode, 49 lines

```vue
<script setup lang="ts" generic="Row extends Record<string, any>">
import type { SortingState } from "@tanstack/vue-table";

// An admin table whose rows, paging and sorting come from the server
// (useServerTable): ui-thing's TanStack table in its manual modes, with the
// Pagination footer counting the server's total. Columns sort by their
// `meta.sortKey` (a key the database function accepts); columns without one
// can't be sorted.
const props = defineProps<{ rows: Row[]; columns: any[]; total: number; page: number; sort: string; desc: boolean; pending: boolean; emptyText?: string }>();
const emit = defineEmits<{ page: [page: number]; sort: [sort: string, desc: boolean] }>();

// TanStack only sorts a column with a value accessor; the server does the
// sorting here, so a column drawn only through its slot gets a placeholder one.
const columns = computed(() =>
  props.columns.map((c) =>
    c.meta?.sortKey ? (c.accessorKey || c.accessorFn ? c : { ...c, accessorFn: () => null }) : { ...c, enableSorting: false },
  ),
);
const columnFor = (sortKey: string) => props.columns.find((c) => c.meta?.sortKey === sortKey);
const sortingState = computed<SortingState>(() => {
  const c = columnFor(props.sort);
  return c ? [{ id: c.id ?? c.accessorKey, desc: props.desc }] : [];
});
function onSorting(state: SortingState) {
  const first = state[0];
  if (!first) return emit("sort", props.sort, !props.desc);   // never "unsorted": flip instead
  const c = props.columns.find((col) => (col.id ?? col.accessorKey) === first.id);
  if (c?.meta?.sortKey) emit("sort", c.meta.sortKey, first.desc);
}
</script>

<template>
  <UiTanStackTable :data="rows" :columns="columns" :loading="pending" manual-pagination manual-sorting
    :row-count="total" :page="page" :sorting-state="sortingState" :empty-text="emptyText"
    @update:pagination="(p) => p.pageIndex + 1 !== page && emit('page', p.pageIndex + 1)" @update:sorting="onSorting">
    <template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope" /></template>
  </UiTanStackTable>
</template>
```

What it relies on in the (modified) ui-thing `UiTanStackTable`:

- Three Lokl-added props: `rowCount` (the server's total; sets the page
  count), `page` (1-based, controlled from the URL), `sortingState`
  (controlled from the URL). Two watchers with `immediate: true` push the
  props into the component's internal `pagination` and `sorting` refs
  when they differ.
- `pageCount` is derived: `manualPagination && rowCount != null ?
  Math.ceil(rowCount / pageSize) : pageCount`.
- The footer uses ui-thing's `UiPagination` (Reka) named "Table pages",
  `total` = `rowCount` in manual mode, `showRowsPerPage: false`,
  `initialPageSize: 25` — every table pages 25 rows with no rows-per-page
  choice (the owner's decision, 2026-10-03).
- Sortable headers are real `<button>`s and the `<th>` carries
  `aria-sort`; the loading state is a 1px animated bar over the table
  while the OLD rows stay visible; the empty row spans all leaf columns
  and takes the `#empty` slot.
- Cell slots are `` `${column.id}-cell` ``; `ServerTable` forwards every
  slot unchanged.
- `meta.sortKey` is not in the type augmentation; `ServerTable` takes
  `columns: any[]`.

## 4. URL validation — predicates, not schemas

Everything is in the composable (§2) and three one-liners:

```ts
export const isUuid = (v) => /^[0-9a-f]{8}-…-[0-9a-f]{12}$/i.test(v);
export const isDay  = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const oneOf  = (...values) => (v) => values.includes(v);
```

Each table declares `filters: { name: predicate }` and `sorts: [...]`;
the same sort keys are mirrored in the SQL function's `c_sorts` map. The
database is the second line of defence: an unknown sort, kind, attention
group or payout setup raises `22023 invalid_parameter_value`; page size is
clamped to 1–100 and page to ≥ 1. A pgTAP case passes
`p_sort := 'b.id; drop table bookings'` and expects `22023` — the
injection guard, proven.

## 5. The page functions — one `jsonb` answer per table

Header comment of the migration that introduced them (verbatim, because
it states the security reasoning the design must weigh):

```sql
-- Access: every function first checks the caller is an admin (42501
-- otherwise), and that check is what guards them: they're security definer,
-- so row-level security doesn't apply inside. Run as the caller, every row
-- went through every read policy on bookings, listings, providers, cities
-- and categories (some with per-row subqueries): about 3,000 scans of those
-- tables per search, 90-200ms at 10,000 bookings. The providers function
-- also reads owners' emails from auth.users. pgTAP checks each function
-- refuses customers, providers and signed-out visitors. All are callable by
-- signed-in users only.
--
-- is_admin() is the right check inside security definer: it reads the
-- caller's sign-in claims (auth.jwt(), from the request), which stay the
-- caller's. current_user would not do: inside a security definer function
-- it's always the function's owner.
--
-- Search: the text is split into words (at most 8, each up to 100
-- characters); every word has to match one of the searched fields. Words are
-- escaped, so % and _ match themselves. Trigram indexes (pg_trgm) keep
-- "contains" searches on titles, names and emails fast.
--
-- Totals: exact for now ("total_exact": true). The shape lets a function
-- switch to an estimate later without the pages changing.
```

The technique, the same in all three dynamic functions:

| Aspect | How |
| --- | --- |
| Signature | `(p_q text, …filters…, p_sort text default '<first>', p_desc boolean default true, p_page int default 1, p_page_size int default 25) returns jsonb`, `language plpgsql stable security definer set search_path = ''` |
| Answer | `jsonb_build_object('rows', v_rows, 'total', v_total, 'total_exact', true, …extras)` — bookings adds `totals` (money across every match) and `attention` (group counts) |
| Access | first statement: `if not public.is_admin() then raise exception 'Admins only.' using errcode = 'insufficient_privilege'; end if;` (42501) |
| Search | `admin_search_patterns(p_q)` → `text[]` of escaped `%word%` patterns (lower-cased, ≤ 8 words, ≤ 100 chars each; `\`, `%`, `_` escaped). Each word appends `and (field ilike $1[i] or field2 ilike $1[i])`: AND across words, OR across fields. Patterns are the bound array `$1`, indexed `$1[%1$s]`; user text is NEVER interpolated |
| Per-field indexes | bookings uses `b.id in (select … where customer_name ilike $1[i] union select … where email ilike $1[i] union …)` so each field hits its own trigram index; a word that looks like `45` or `$45.00` also matches `total_cents` exactly |
| Filters | `' and col = $N'` appended, values bound through `USING`; "needs attention" groups are whitelisted SQL fragments in a constant jsonb map |
| Dynamic ORDER BY | `c_sorts constant jsonb := jsonb_build_object('created', 'b.created_at', 'when', 'coalesce(b.starts_at, b.created_at)', …)`; unknown key → `22023`; expression via `format('%3$s')`, direction via `case when p_desc then 'desc' else 'asc' end`; `order by s <dir> nulls last, id <dir>` (stable tiebreak) |
| Count + page | `with matched as materialized (select id, <sort expr> as s …where…), page as (select id, row_number() over (order by s, id) as n from (select id, s from matched order by s, id limit v_size offset (v_page-1)*v_size) x)` then `select (select count(*) from matched), (select jsonb_agg(jsonb_build_object(…) order by page.n) … join page on page.id = b.id)`. The matches are found ONCE for both total and page; only ids and sort keys are sorted; JSON is built for the page's rows only |
| Clamps | `v_size := least(greatest(coalesce(p_page_size, 25), 1), 100)`; `v_page := greatest(coalesce(p_page, 1), 1)`; a page past the end returns `[]` with the real total |
| Grants | `revoke execute … from public, anon; grant execute … to authenticated;` restated for every signature |
| Changing arguments | `drop function …(old signature)` then `create` — `create or replace` would add an overload — and the revoke/grant re-issued |

Date filters are calendar days in the booking's market zone, with a
`±1 day` outer bound on the raw timestamp so the timestamp index narrows
first, then the exact `(ts at time zone tz)::date` comparison:

```sql
if p_from is not null then
  v_where := v_where || ' and coalesce(b.starts_at, b.created_at) >= ($5::date - 1)::timestamptz
    and (coalesce(b.starts_at, b.created_at) at time zone coalesce(c.timezone, ''America/New_York''))::date >= $5';
end if;
```

The static sibling, `admin_reviews_page`: `where (p_x is null or col = p_x)`,
fixed order, a `counted` CTE, no `EXECUTE`, no search. Good enough when a
table has no free-text search and one sort.

The providers function also shows the "only what the page shows" rule:
its JSON never includes the Stripe account id or the owner's id, and a
pgTAP case asserts the exact key set.

## 6. `pg_trgm` and the indexes

```sql
create extension if not exists pg_trgm with schema extensions;

-- "Search anything": contains-searches on these use the trigram indexes.
create index if not exists bookings_customer_name_trgm on public.bookings using gin (customer_name extensions.gin_trgm_ops);
create index if not exists booking_contacts_email_trgm on public.booking_contacts using gin (email extensions.gin_trgm_ops);
create index if not exists listings_title_trgm on public.listings using gin (title extensions.gin_trgm_ops);
create index if not exists providers_display_name_trgm on public.providers using gin (display_name extensions.gin_trgm_ops);

-- Filters and the default orders.
create index if not exists bookings_created_idx on public.bookings (created_at desc) where status <> 'pending_payment';
create index if not exists bookings_status_created_idx on public.bookings (status, created_at desc);
create index if not exists bookings_when_idx on public.bookings ((coalesce(starts_at, created_at)));
create index if not exists providers_created_idx on public.providers (created_at desc);
```

- The extension lives in the `extensions` schema (Supabase convention), so
  the opclass is qualified `extensions.gin_trgm_ops`.
- One GIN index per searched column; no concatenated or generated search
  column. The bookings function UNIONs per-field id lookups so each gets
  its own index.
- `auth.users.email` has no trigram index (Supabase's schema).
- The default-order and filter indexes are plain btrees, partial where
  the predicate is constant.

## 7. The provider picker — a filter whose options come from the server

`useProviderPicker(selectedId)` wraps the SAME page function the Providers
table uses, with `p_page_size: 20`, sort `name` ascending, and maps rows
to `{ value: id, label: display_name, description: owner_email }` ("two
businesses can share a name: the owner's email tells them apart"). The
chosen id becomes the table's `provider` URL filter (`isUuid`); after a
reload the label is looked up separately from the id so the box names
it before any search. `SearchSelect` (ui-thing `UiAutocomplete` on Reka
Combobox) has a `search(term, signal)` server mode with its own 300ms
debounce and AbortController, `:ignore-filter` in server mode, a
"Searching…" `role="status"` line, and a first-open search of `''`.

## 8. Proof

pgTAP, `supabase/tests/admin_search_pages.test.sql`, `plan(49)`, via
`npm run db:test` and helpers (`tests.create_user`,
`tests.authenticate_as`, `tests.authenticate_as_admin`,
`tests.authenticate_as_anon`). What it asserts, by group:

- **Access:** `throws_ok(..., '42501', 'Admins only.')` for a customer, a
  provider (even for their own bookings), and anon.
- **Search:** finds by customer name, email case-insensitively, listing
  title, provider name; every word must match (`'peach rivera'` → 1,
  `'peach nobody'` → 0); `'100%'` matches only "100% Fun Club", `'jo_ann'`
  only "Jo_Ann" — the escaping, proven; `'$130.00'` finds the booking
  charged that amount.
- **Filters, sort, page:** status/kind, provider, date range, open-ended
  `p_from`; attention counts cover every booking regardless of search;
  `p_sort := 'b.id; drop table bookings'` → `22023`; pages of 2 cover all
  6 bookings exactly once; page 9 returns `[]` with total 6.
- **Totals:** equal the sums over all matches; a fully refunded booking
  keeps no commission; independent of page size; follow filters; no
  matches gives zeros, not nulls.
- **Row shape:** the providers row keys are exactly `city, created_at,
  display_name, id, owner_email, payout_setup, status`.

Performance, `scripts/bench-admin-search.mjs` (refuses anything but the
local stack): for 19 cases it measures database time (median and max of
20 runs, as an admin via `set local request.jwt.claims` and `set local
role authenticated`), index usage (diffing `pg_stat_user_indexes.idx_scan`
and `pg_stat_user_tables.seq_scan`, because auto_explain is not available
on Supabase), and the API round trip through `supabase-js` as a temporary
admin it creates and deletes. `scripts/seed-admin-load.mjs` seeds 200
providers, 1,000 listings, 2,000 customers and 10,000 bookings.

Not proven: no unit test of `useServerTable`, `ServerTable` or
`TableSearch`; no e2e of paging or sorting — the e2e specs only navigate
with `?q=` to show a URL search loads the filtered table.

## 9. Patterns worth carrying into The Reserve

1. **The URL is the state, checked.** The composable's shape: declared
   filters with predicates, a sort whitelist whose first entry is the
   default, `page` dropped when 1, push for filters/sort/page and replace
   for search, every change but paging back to page 1, invalid values
   dropped silently. Back, reload and bookmarks work for free.
2. **Newest request wins.** One AbortController per load, passed to
   `.abortSignal()`, with `pending` tied to the newest request. This is
   what makes typing-while-loading safe.
3. **TanStack in manual mode, driven from props.** `manualPagination` +
   `manualSorting`, `rowCount` from the server, `page` and `sortingState`
   controlled from the URL, sort keys on `meta.sortKey`, placeholder
   accessors for slot-only columns, never "unsorted". Search and filters
   OUTSIDE TanStack, in a `role="search"` form.
4. **One function, one answer.** `jsonb { rows, total, total_exact,
   …extras }`, matches found once (`materialized`), ids sorted and cut,
   JSON built for the page only, clamps on page/page_size, a stable id
   tiebreak, `nulls last`.
5. **Whitelists for everything dynamic.** `c_sorts` map, `22023` on an
   unknown key, user text only ever a bound `$1[i]` pattern, `search_path
   = ''` with qualified names. The injection pgTAP case.
6. **Words AND, fields OR, escaped.** `admin_search_patterns` is a
   reusable helper; per-field id-UNION lets each field use its own
   trigram index.
7. **Totals in the same query.** Money across every match comes back
   with the page, from the same `matched` set, so a total can never
   disagree with the rows it sits above.
8. **Calendar-day filters in the business zone** with a `±1 day` raw
   bound for the index — exactly the business-time convention The
   Reserve adopted 2026-10-06.
9. **Return only what the page shows**, and assert the row's key set in
   the proof.
10. **A server-searched picker reusing the page function**, label looked
    up from the id after reload.
11. **Benchmark on a seeded local stack**, measuring index scans, not
    just milliseconds.

## 10. Lokl-only decisions not to copy blindly

- **Admin-only callers, one role, one tenant.** `is_admin()` reads
  `auth.jwt() -> app_metadata ->> role`; there is no organisation
  predicate anywhere, because the marketplace has one admin team that
  may see every row. The Reserve has four roles with different
  permissions and more than one organisation in the database.
- **`security definer` as a performance choice.** Chosen because per-row
  RLS with subqueries cost 90–200ms at 10,000 bookings, and because the
  providers function reads `auth.users.email`. The safety then rests
  entirely on the first-statement gate, qualified names, whitelists and
  the pgTAP access cases. In The Reserve a definer function that forgot
  `current_org_id()` would read across organisations silently; the
  design doc settles this (decision 1).
- **No server route.** The SPA calls RPC directly. The Reserve renders
  with SSR and has `requireUser(event)` routes for anything privileged;
  reads under RLS also go straight through the Supabase client, so the
  shape matches, but the SSR page should `await` its first load.
- **No zod.** Three predicates are enough for Lokl; the brief for The
  Reserve asks for zod URL schemas with unit tests, which is a stricter
  contract and fits the house rule on two paths deciding one predicate
  (the SQL whitelist still backs it).
- **Hard-coded zone fallback** `'America/New_York'` in the date filters.
  The Reserve has `locations.timezone` and `shared/time/zone.ts`.
- **Domain rules in the function** (exclude `pending_payment`, money sorts
  treat never-charged as -1, a full refund keeps no commission). The
  Reserve's equivalents are its own revenue definitions, which must be
  ONE definition shared with the KPI cards (decision 2).
- **pgTAP** for the database proof. The Reserve proves database rules
  with the `verify-*.mjs` harnesses on the local stack and has no pgTAP;
  the same assertions move into that shape.
- **25 rows, no choice.** An owner's call; The Reserve can take it or
  not.
- **Generated types return `Json`** for the page functions; pages cast
  through `asServerPage<Row>` with hand-written row interfaces. The
  Reserve's `db:types` would do the same unless the functions return a
  typed `table(...)`.

## What the design has to decide

The design doc (`docs/design/server-tables-design.md`) takes the shapes
above and settles, for The Reserve: invoker versus definer and what
proves it; one shared revenue definition for the Transactions totals;
the period selector's URL and zone; search fields per table; whether
search text belongs in the URL; which pieces become shared code and how
the `pg_trgm` migration is written; the harness, unit, e2e and
performance proofs; and the build order.
