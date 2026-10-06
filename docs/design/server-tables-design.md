# Server-side tables — design

Status: APPROVED 2026-10-06 with five refinements (folded in below, each
marked `[APPROVED]`). PR 1 (`/clients`) in progress; PR 2 and PR 3 to
follow the build order. Inputs: `docs/server-tables-reference.md` (how
Lokl does it, read 2026-10-06) and `server-tables-survey.md` (what The
Reserve did on that date).

## What this is

Lokl's pattern, brought to three places: `/clients`, `/products`, and the
Transactions table on `/financials`, which also gets a period selector
(day, week, month, year, custom range) at the top. The URL holds the
table state; one composable drives it; ui-thing's TanStack table runs in
its manual modes; one Postgres function per table does the searching,
filtering, sorting, counting and paging and returns one page plus the
total — and, for transactions, the money totals across every match.

Why now: every one of these pages loads every row and is silently capped
at PostgREST's `max_rows`; on `/financials` the capped array is also what
the revenue cards sum. The work closes that hole, moves the ledger's
bucketing onto the location's zone per the CLAUDE.md business-time
convention, and writes the revenue definition down once.

The governing rule: **the database answers the question the page asks,
under the caller's own permissions, in the location's zone, and the
totals come from the same matched set as the rows.**

## Decisions

### 1. Security model — `security invoker`, with an explicit permission check that fails loudly

**Recommendation: invoker.** Every page function is
`language plpgsql stable security invoker set search_path = public`,
granted to `authenticated` and revoked from `public, anon`. RLS and
`current_org_id()` apply to every row it reads exactly as they do to the
pages today; a function that forgot an org predicate cannot leak, because
it never had the power to.

Why Lokl's reason does not transfer. Lokl went definer because its
functions are called only by admins and its per-row policies with
subqueries cost 90–200ms at 10,000 bookings. The Reserve's pages are used
by four roles with different permissions and the database holds more than
one organisation; a definer function that missed `current_org_id()` or a
permission would read across organisations silently, and the only thing
standing between that and production would be the harness. The Reserve's
read policies are also cheaper than Lokl's: `clients_read`,
`products_read` and `transactions_read` are a column equality plus two
`stable security definer` SQL helpers (`current_org_id()`,
`has_permission()`), which the planner can hoist and the
`(organization_id, …)` indexes serve. Only `transaction_items_read` and
`payments_read` carry an `exists` subquery, and the transactions function
touches those tables for the page's 25 rows only, after the match and
the cut.

**Loud, not empty.** Under invoker, a caller without `clients.view` gets
zero rows and total 0 — the same answer as an empty organisation, which
is the silent-failure class. So each function's first statement is an
explicit check that raises:

```sql
if not has_permission('clients.view') then
  raise exception 'clients.view required' using errcode = 'insufficient_privilege';  -- 42501
end if;
```

The page shows that as an error, not an empty table. RLS stays the
backstop; the check is the signal.

**When definer would be justified, and only then.** If the performance
check (decision 7) shows a page function over the seeded load exceeding
the budget there — p50 above 50ms or max above 200ms of database time
for any of its cases — and the cost is traced to policy evaluation
rather than a missing index, the function may become `security definer`
with THREE conditions, all proven by the harness: (a) `organization_id =
current_org_id()` appears in every `where` it builds, as a literal
predicate, not through RLS; (b) the `has_permission()` check is the first
statement; (c) the two-organisation harness case passes with real
sessions in both organisations. Without the measurement, no definer.

### 2. Financial definitions — one definition, in the database, and the UI already agrees with itself

**Reported before designing, as asked.** The survey (§5) found that the
two existing UI places agree with each other and nothing else agrees
with them:

- `financials.vue` cards and `KpiCards.vue` both define revenue as
  `service` + `product` item `total_cents`: pre-tax, GROSS of discounts,
  NET of refunds (through the negative mirror items), excluding tips,
  gift-card sales and late-cancellation fees.
- Ask's `revenue_this_month` preset includes tip, discount and fee rows
  by kind; the Ask prompt tells the model "a plain SUM over transactions …
  is usually what someone means by revenue" (that sum includes tax, tips
  and gift-card sales); `top_spenders_quarter` is gross and includes tax;
  `gift_cards_outstanding` means untouched cards where the UI means the
  sum of active balances; the prompt's kind list omits
  `late_cancellation_fee`.
- The late-cancellation fee appears in NO UI total. The column comment
  calls it "revenue, but not service or retail revenue".
- Bucketing: browser clock with a Sunday week (financials), rolling 7
  days from browser-local midnight (KPI), UTC with an ISO Monday week
  (Ask).

**Recommendation.** Take the UI's definition as THE definition, because
it is what the owner has been reading, and write it once in Postgres:

| Figure | Definition |
| --- | --- |
| `service_cents` | sum of `transaction_items.total_cents` where `kind = 'service'` |
| `retail_cents` | same, `kind = 'product'` |
| `revenue_cents` | `service_cents + retail_cents` — pre-tax, gross of discounts, net of refunds |
| `tips_cents` | `kind = 'tip'` |
| `discounts_cents` | sum of `transactions.discount_cents` (positive on sales, negative on refunds: net) |
| `tax_cents` | sum of `transactions.tax_cents` |
| `gift_cards_sold_cents` | `kind = 'gift_card'` — a liability, never in revenue |
| `fees_cents` | `kind = 'late_cancellation_fee'` — NEW, its own figure, so the fee stops being invisible |
| `refunds_cents` | sum of `-total_cents` over rows with `refunds_transaction_id` not null |
| `txn_count`, `avg_ticket_cents` | non-refund rows; `avg_ticket` = positive total / count |

All nets happen through the mirror rows; nothing is filtered by sign.
Refunds stay in the period they were ISSUED (their own `created_at`),
which is what the ledger records and what the cards do today.

**One implementation, Lokl's trick.** `transactions_page(...)` computes
`totals` over its `matched` set (range + filters + search), the way
`admin_bookings_page` does. The summary cards on `/financials` and the
KPI card on the dashboard do NOT get a second function: they call the
same `transactions_page` with `p_page_size => 1` and read `-> 'totals'`,
exactly as Lokl's `admin_dashboard()` does. There is then no second copy
to drift. (A thin SQL wrapper `ledger_totals(p_from, p_to)` that does
that call is acceptable for readability; it must contain no arithmetic.)

**What this changes on screen.** A new "Fees" card (late-cancellation
fees); the per-provider table keeps attributing `service` and `tip` by
`item.staff_id` and reads from a `by_staff` array returned by the same
function rather than re-summing in the browser. `[APPROVED]` `by_staff`
includes EVERY staff member with revenue or tips in the period,
deactivated ones included — the survey found the page lists only active,
bookable staff, so a deactivated provider's revenue silently dropped out
of the table while staying in the cards. `[APPROVED]` Each transaction
row returned by `transactions_page` carries a `refunded` boolean (a
later transaction with `refunds_transaction_id = this.id` exists), so
the Refund button no longer depends on the refund having been loaded in
the current period; the server's 409 stays as the backstop. The Ask
presets and prompt are OUT of scope here and are on the board:
`revenue_this_month` should group only `service`/`product` as revenue and
show the others as their own lines; the prompt's "plain SUM" sentence
should go; `gift_cards_outstanding` should mean the sum of active
balances.

**Two things for the owner to confirm, not assume** (on the board as
owner confirmations): (a) revenue stays GROSS of discounts, with
Discounts as its own figure — the current cards' behaviour, now stated;
(b) the fee is shown as "Fees", separate from revenue — the column
comment's intent, now visible. Either answer is a one-line change in the
function; the point is that it is written down.

### 3. The period selector — in the URL, resolved in the location's zone, one derivation

**URL shape.**

```
/financials                              month containing today (the default)
/financials?period=week&anchor=2026-10-06
/financials?period=day&anchor=2026-10-06
/financials?period=year&anchor=2026-10-06
/financials?from=2026-10-01&to=2026-10-31   custom, inclusive calendar days
```

`period` is one of `day | week | month | year`; `anchor` is a
`YYYY-MM-DD` key inside the period (dropped from the URL when it is
today, like `page=1`); `from`/`to` are present only for a custom range
and take precedence when both are valid. Prev/next buttons move
`anchor` by one period; the four buttons set `period` and clear
`from`/`to`; the date picker sets `from`/`to` and clears `period`. All
of these `router.push`, so Back walks back through periods.

**Preset to range.** One pure function in `shared/time/period.ts`:

```ts
periodRange({ period, anchor } | { from, to }, timeZone): { from: Date; to: Date; label: string }
```

returning the half-open UTC window `[from, to)` whose edges are the
LOCATION's local midnights, via `localToUtc(dateKey, "00:00", tz)` from
`shared/time/zone.ts`. Day: the anchor's day. Week: the week containing
the anchor. Month: `YYYY-MM-01` to the next month's first. Year: `YYYY-01-01`
to the next year's. Custom: `from` to `to + 1 day`. Calendar arithmetic
happens on keys (the noon-anchor rule from the schedule page), the
conversion to instants happens in the zone, and DST days come out 23 or
25 hours long as they should.

**Week start: Sunday.** The financials page already uses a Sunday week,
the schedule's month grid is Sunday-first, and the KPI/Ask Monday weeks
are the outliers. Stated here and in the function's doc comment so the
next person does not "fix" it to ISO.

**Default: month**, anchored on today in the location's zone (the page
reads it from `useLocationTimezone()`), matching the page today.

**Range drives both.** The page computes `{ from, to }` ONCE from the URL
through `periodRange` and passes the two instants to
`transactions_page(p_from, p_to, …)`. The SQL does not re-derive the
period — it filters `created_at >= p_from and created_at < p_to` on the
existing `transactions_org_day` index — so there is one derivation, not
two to test for agreement. The KPI card asks for the same function with
its own window (a rolling 7 days ending now, built with the same helper
from `localDateKey(now, tz)`), so it moves onto the location's zone too.
Unit tests cover the helper in zones that differ from the runner's, DST
edges, the Sunday week, and the custom inclusive end (decision 7).

The page's `rangeLabel` and the picker's display format from the keys,
never from `Date` in the browser's zone.

### 4. Search fields per table

| Table | Search covers | Never |
| --- | --- | --- |
| Clients | `first_name`, `last_name`, `email`, `phone` — a word matches any of them; phone matches on digits only, so "555 0100" finds "(555) 010-0…" | notes of either kind, `flags`, `date_of_birth`, the address, the emergency contact, `referral_source`, communication preferences, anything audited |
| Products | `name`, `sku` — what the placeholder already promises | `description` (undocumented today, dropped), `cost_cents` |
| Transactions | the client's name (or "Walk-in" matches rows with no client), item `name_snapshot`, payment `reference`, the note, and an exact amount when the word looks like `45` or `$45.00` (Lokl's trick, against `total_cents`) | the cashier (becomes a filter, below), payment method words (a filter) |

Words AND, fields OR, escaped, at most 8 words of 100 characters — the
`search_patterns(p_q)` helper copied from Lokl's `admin_search_patterns`.
Filters, outside the search: clients `active` (`all | active | inactive`,
default active, replacing the "Show inactive" toggle); products `active`
the same, plus `stock` (`out | low`); transactions `kind`
(`sale | refund | fee`), `method`, `staff` (cashier or attributed
provider), and the period (decision 3).

### 5. Search text in the URL — out of it for clients and transactions, in it for products

**Recommendation: `q` stays OUT of the URL on `/clients` and
`/financials`.** The organisation's own rule treats client names, emails
and phones as sensitive; a `?q=maria+alvarez` lands in browser history,
in hosting request logs (the page is server-rendered, so the URL reaches
Nuxt's request log on every reload) and in anything that captures the
address bar. For those two pages the search box's text lives in page
state and is kept per tab in `sessionStorage` under the route path, so
it survives a reload in the same tab, never enters history, is never
shareable and is gone when the tab closes. The RPC carries it in a POST
body, which PostgREST does not log by default.

**On `/products` `q` goes in the URL** — product names and SKUs are not
sensitive, and a shareable "show me the low-stock oils" link is useful.

**The trade-off, stated.** Everything else — filters, sort, page, period
— is in the URL on all three pages, so Back, reload and bookmarks work
for the state that matters; what is lost on clients and transactions is a
shareable or bookmarkable SEARCH, and a search does not survive Back
(Lokl replaces history on search anyway, so Back never undid a search
there either). The composable takes `search: "url" | "session"` per
table so the choice is explicit at the call site and the default is
`"session"`.

### 6. The shared pieces, and how the migration is written

Shared code, all under `apps/reserve`:

| Piece | Where | What it is |
| --- | --- | --- |
| `useServerTable(opts)` | `app/composables/useServerTable.ts` | Lokl's composable, with the zod schema for the URL (below), the `search` mode (decision 5), `load(query, signal)`, newest-request-wins, `setFilter/setFilters/setSearch/setPage/setSort/clear/refresh`, `filtering`. Reports errors through `useToast`, not `console.error` |
| `ServerTable` | `app/components/ServerTable.vue` | Lokl's 49 lines: manual pagination + sorting, `meta.sortKey`, placeholder accessors, never unsorted, slots forwarded |
| `TableSearch` | `app/components/TableSearch.vue` | the 300ms-debounced box, follows the value unless focused; keeps the existing placeholders, which the clients e2e journey finds |
| `UiTanStackTable` | `app/components/Ui/TanStackTable.vue` | gains Lokl's three props — `rowCount`, `page`, `sortingState` — the derived `pageCount`, the two `immediate` watchers, `aria-sort` and button headers; a header comment names the change so a CLI re-add keeps it. Page size 25, no rows-per-page choice, on these three tables (an owner's call, as it was at Lokl; the client-side tables elsewhere keep 10) |
| URL schema helpers | `shared/tables/url.ts` | zod: `page` (coerced int ≥ 1, default 1), `dir` (`asc|desc`), `sort(keys)` (enum, first is default), `oneOf(...)`, `uuid`, `day`, `period`, `anchor`, `from/to`; a `parseTableQuery(schema, route.query)` that takes the first value of a repeated key and falls back to defaults on anything invalid, never throwing. `shared/` so the unit tests run in node |
| `periodRange` | `shared/time/period.ts` | decision 3 |
| `asServerPage<Row>(data, error)` | with the composable | the `{ rows, total, total_exact, …extras }` normaliser |
| Server-searched picker | later | the cashier/provider filter on transactions can be a plain select of active staff (short list); no `SearchSelect` port in this phase |

The database, one migration per table in the build order, each in the
house style:

```sql
-- ============================================================
-- Migration: server-side tables — clients (search, filter, sort, page)
-- npx supabase migration new server_tables_clients
-- ============================================================
create extension if not exists pg_trgm with schema extensions;   -- first migration only

-- "Search anything": contains-searches on these use the trigram indexes.
create index clients_first_name_trgm on clients using gin (first_name extensions.gin_trgm_ops);
create index clients_last_name_trgm  on clients using gin (last_name  extensions.gin_trgm_ops);
create index clients_email_trgm      on clients using gin (email      extensions.gin_trgm_ops);
create index clients_phone_digits_trgm on clients using gin ((regexp_replace(coalesce(phone, ''), '\D', '', 'g')) extensions.gin_trgm_ops);
-- Default order and the active filter.
create index clients_org_active_name on clients (organization_id, active, last_name, first_name);
```

`search_patterns(p_q text) returns text[]` once (`immutable`, revoked
from `anon`). Then `clients_page(p_q, p_active, p_sort, p_desc, p_page,
p_page_size) returns jsonb` in Lokl's shape — `c_sorts` whitelist and
`22023` on an unknown key, patterns bound as `$1[i]`, filters bound
through `USING`, `matched as materialized`, ids sorted and cut with a
stable `id` tiebreak and `nulls last`, JSON built for the page only,
clamps 1–100 and ≥ 1, `total_exact: true`. The permission check from
decision 1 first. Returning ONLY what the list shows: id, names, email,
phone, active, no_show_count, flags — not DOB, not the address, not the
emergency contact.

`products_page` the same with `name`/`sku` trigram indexes and sorts
`name | price | stock | margin` (margin computed in SQL; the function
returns `cost_cents` only when the caller holds `products.manage`, so the
column stops shipping to everyone).

`transactions_page(p_from timestamptz, p_to timestamptz, p_q, p_kind,
p_method, p_staff_id, p_sort, p_desc, p_page, p_page_size)` with trigram
indexes on `transaction_items.name_snapshot`, `payments.reference` and
`transactions.note`, the client-name search through `clients`' indexes,
sorts `when | client | total`, and the `totals` and `by_staff` objects
from decision 2. The `METHOD_LABELS` gap (`stripe_card`) is fixed on the
way.

Changing a function's arguments later means `drop function` with the old
signature, then `create`, then the revoke/grant again — `create or
replace` would add an overload (Lokl's note, kept).

### 7. Proof

**Harness, `scripts/verify-tables.mjs`**, in the `verify-messages.mjs`
shape, run by the CI `database` job, tagged fixtures, both directions,
non-vacuous, exit 1 on any failure. Per function:

- No permission: a staff member whose role lacks the view key gets
  `42501` from the function (decision 1), AND a direct `select` under
  their session returns zero rows — the signal and the backstop, both.
- With permission: the holder finds the fixture by each searched field;
  every word must match; `100%` and `jo_ann` prove the escaping; an
  injected sort raises `22023`; pages of 2 cover the fixtures exactly
  once; a page past the end returns `[]` with the real total.
- Two organisations, LOCAL stack only (like the time-off scoping check):
  two organisations, a staff member WITH A REAL SESSION in each
  (`staffMember()` the way `verify-messages` makes one, signed in through
  the anon key), the same search in both; organisation A's rows never
  appear in B's results, B's totals exclude A's transactions, and the
  counts are non-zero on each side so the check is not vacuous. Skipped
  with a printed line when not under `SUPABASE_LOCAL`.
- Transactions totals: fixtures with a sale, a discount, a tip, a
  gift-card sale, a late fee and a refund; `totals` equal the
  hand-computed figures of decision 2 (revenue gross of discounts and net
  of the refund, the fee in `fees_cents` only, gift card excluded); the
  totals do not change with `p_page_size`; `p_page_size => 1` returns the
  same totals as the full page, which is what the cards rely on.

**Unit tests**, vitest, `tests/shared/tablesUrl.test.ts` and
`tests/shared/period.test.ts`: the zod helpers across invalid, repeated
and missing keys (never throw, always a default); `periodRange` for each
preset in America/New_York, Asia/Kolkata and Pacific/Auckland (none the
runner's), across the spring-forward and fall-back days (23- and
25-hour days), the Sunday week start, the custom inclusive end, and the
TZ-swap case from `zone.test.ts`.

**E2E, `e2e/journeys/04-tables.spec.ts`** on `/clients` (the reference
table): sign in as front desk, apply the `active=all` filter and a
`noShows` sort, assert the URL carries both and the rows reflect them;
reload; assert the same URL and the same first row; press Back; assert
the sort is still there and the filter is gone — the URL is the state and
Back undoes the LAST filter change. `TestData` gains nothing new for this;
the clients journey's builders suffice.

**Performance, local stack only**: `scripts/seed-tables-load.mjs` seeds
10,000 clients, 2,000 products and 50,000 transactions with items and
payments into the seeded organisation (refusing anything not behind the
localhost guard), and `scripts/bench-tables.mjs` runs each function's
cases 20 times as a real staff session, reporting database p50/max and
the `pg_stat_user_indexes.idx_scan` / `pg_stat_user_tables.seq_scan` diff
(Lokl's method). Budget: p50 ≤ 50ms, max ≤ 200ms; a sequential scan on a
searched table is a failure regardless of time. The numbers go into this
doc as `[AS-BUILT]` lines, and they are the only thing that can reopen
decision 1.

`[AS-BUILT 2026-10-06, clients_page, 10,000 clients in one organisation,
20 runs a case, local stack]` Every case — the default name sort, name
descending, no-shows, contact, a common first name, two words, an email
fragment, phone digits, a rare string, all-including-inactive, page 100,
the 8-row picker — measured p50 226–267ms and max 237–401ms of database
time, uniformly, with zero sequential scans and the
`clients_org_active_name` and primary-key indexes in use. Uniform across
sorts and searches means the cost is not the sort expression (the
question about aligning the name sort with the index's
`lower(last_name), lower(first_name)` is answered: aligning them would
change nothing, so nothing was changed) and not the search. It is the
RLS policy: `clients_read` calls `current_org_id()` and
`has_permission('clients.view')` PER ROW, and a bare
`select count(*) from clients` as the holder costs the same 255ms. With
the policy's two calls wrapped as `(select current_org_id())` and
`(select has_permission('clients.view'))` — evaluated once per statement,
the same truth value, the documented Supabase pattern — the same count is
0.7ms. That became its own migration (20261006224905,
`clients_policies_evaluate_once`, clause for clause with the four
policies as they stood), and the benchmark re-run with it, same seed,
same cases, 20 runs each: p50 between 4.8ms (all clients, including
inactive) and 32.2ms (the common first name "maria", 334 matches), max
54.7ms (the default page), every case inside the budget, no sequential
scans. The harnesses (tables 31, forms 48, ask 17, messages 43, leads
72) and all six journeys passed unchanged before and after the policy
change — same rows, same refusals. Decision 1 stands: invoker. The same
per-row cost sits in every other policy and is on the board as one
dedicated sweep, with the ledger's three policies taken in PR 3.

`[AS-BUILT 2026-10-06]` One client-side finding on the way: restoring the
session search in `onMounted` never reached the rows, because `onMounted`
fires while Nuxt is still hydrating and a watch-triggered `useAsyncData`
refresh during hydration is answered from the server payload (Nuxt's
default `getCachedData`). The restore runs in `onNuxtReady` instead, and
the tables journey's reload step is what proves it.

`[AS-BUILT 2026-10-06, PR 2, products_page, 2,000 products and 10,000
clients seeded, 20 runs a case, local stack]` The products policies were
wrapped in the same migration as the function, so there is no "before"
to report; every case lands well inside the budget: default page 1.7ms,
name descending 1.7ms, price 1.3ms, stock 1.3ms, margin as a manager
1.6ms, the common word "lotion" (100 matches) 2.3ms, a SKU 2.3ms, low
stock 1.3ms, out of stock including inactive 1.2ms (p50; max ≤ 2.5ms), no
sequential scans. The clients cases re-run in the same session on a quiet
machine: p50 2.7–9.8ms, phone digits 29.9ms. One reading to know about:
the benchmark's per-index `idx_scan` deltas come from the statistics
collector, which flushes lazily, so a case can print "idx: none" while
`seq_scan` stays at zero; the sequential-scan count is the budget's
signal, and it held.

`[AS-BUILT 2026-10-06, PR 2]` The low-stock threshold is one shared
definition (`shared/products/stock.ts`, `LOW_STOCK_THRESHOLD = 5`,
`stockLevel()`): the page's badge reads it, `verify:tables` imports it
and asserts the function's boundary against it — a product at the
threshold is low, one above is not, zero is out and not low — and the
SQL literal is a commented copy, so either side moving alone fails the
harness. The cost split is proven in both directions: a viewer with
`products.view` only gets exactly the eight catalogue fields and 42501 on
a margin sort; a manager gets `cost_cents` and `margin_pct`, null when
there is no cost. The products search is in the URL (decision 5), proven
by journey 5 through a reload.

### 8. Build order

1. **`/clients`, end to end — the reference implementation.** One PR:
   the `pg_trgm` migration with the clients indexes, `search_patterns`,
   `clients_page`; the shared pieces (composable, `ServerTable`,
   `TableSearch`, the three `UiTanStackTable` props, `shared/tables/url.ts`);
   the page moved onto them with the same placeholder and the same
   columns; `verify-tables.mjs` with the clients cases and the two-org
   check; the URL-schema unit tests; the e2e journey; the clients unit
   test rewritten for the new load path. `[APPROVED]` The forms page's
   client picker (`forms/index.vue`, `searchClients`) moves onto
   `clients_page` with `p_page_size => 8` and `p_active => 'active'`,
   which fixes its unescaped `.or(ilike…)` interpolation and removes the
   second search implementation. "Built" means front desk can search,
   filter, sort, page, reload and go Back on the real page, and send a
   form to a client found through the same function.
2. **`/products`.** Its migration and function, the `cost_cents`
   permission split, its harness cases. Small, because the pieces exist.
   `[AS-BUILT]` Built as PR 2 on 2026-10-06; the products policies wrapped
   in the same migration; the stock filter (`out | low`) added with the
   shared threshold; the edit dialog reads the one row it opens.
3. **`/financials`.** The transactions migration and function with
   `totals`/`by_staff`; `shared/time/period.ts` and its tests; the period
   selector in the URL; the cards and the per-provider table reading
   `totals` and `by_staff` from the function; `KpiCards` calling the same
   function for its window; the "Fees" card; the harness totals cases.
   `[APPROVED]` This PR also settles the gate mismatch found in the
   survey: the `/financials` gate becomes BOTH `financials.view_summary`
   AND `transactions.view`, on the page (`definePageMeta`, the `can`
   middleware taking a list) and in the nav and command palette. No
   implicit permission grants as data: the roles are not changed, the
   gate names what the page needs. `by_staff` and `refunded` (decision
   2) are built here.
4. Not in this work, recorded for the board: the Ask presets and prompt
   brought onto the shared definition; the owner confirmations of
   decision 2; `migration4a-design.md`'s claim of a trigger asserting
   `sum(payments) = transactions.total`, which does not exist (add a
   constraint trigger or correct the doc); `/transactions` (the 50-row
   list) either folded into `/financials` or moved onto
   `transactions_page`; `GiftCardsSection` onto a page function; the
   checkout page's client and product pickers onto the search functions.

## Deliberately deferred

- Keyset pagination: offset/limit with a materialized match set is what
  Lokl runs at 10,000 rows in 1–36ms; revisit only if the benchmark says so.
- Estimated totals (`total_exact: false`): the shape is kept, the
  behaviour is not built.
- A server-searched picker (`SearchSelect`): the staff filter is a short
  list today.
- Per-location slicing of financials (multi-tenancy-status item): the
  functions take the organisation from the caller; a `p_location_id`
  filter is a one-line addition when a second location exists.
- Export: `financials.export` is a separate permission and a separate
  feature; nothing here writes files.
