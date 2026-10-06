# Server-side tables — survey of The Reserve as it stands

Read 2026-10-06, read-only, on main at `52a000b`. This is stage 2 of the
server-side tables work: what `/clients`, `/products` and the Transactions
table on `/financials` do today, what gates them, what RLS applies, and
every place that computes money totals with its definition of revenue.
The design that follows is `server-tables-design.md`; the pattern being
brought over is in `docs/server-tables-reference.md`.

The short version: all three pages load EVERY row through the browser
Supabase client with no `.limit()`, then search, filter, sort and page in
the browser. PostgREST caps a response at `max_rows` (1,000 on the local
stack; the hosted value is set in the dashboard and is not in the repo)
and returns the first 1,000 rows WITHOUT an error. On `/financials` the
same capped array feeds the revenue, tips, tax, discount and refund cards
and the per-provider earnings, so past 1,000 transactions in a period the
TOTALS are silently wrong, not just the table. This is the silent-failure
class CLAUDE.md names.

## 1. `/clients` — `apps/reserve/app/pages/clients/index.vue`

**Load.** `useAsyncData("clients-list")` over the browser client:
`from("clients").select("*").order("last_name").order("first_name")`. No
server route, no limit, active and inactive rows both fetched.
`select("*")` ships every column to the browser for a list that shows
name, contact and no-show count — including `date_of_birth`, the address
fields and the emergency contact. That is personal data on a list view
and the page function should return only what the list shows.

**Cap.** None in code, so `max_rows` applies: past 1,000 clients the page
drops rows alphabetically after the cutoff and the search box cannot find
them. Related pickers have their own caps: the command palette loads
active clients with `.limit(500)`; `checkout.vue` loads ALL active clients
with no limit; `forms/index.vue` searches with
`.or(\`first_name.ilike.%${q}%,…\`)` and `.limit(8)` — the only
server-side search precedent in the app, and it interpolates the typed
text unescaped, so `,`, `(`, `)` or `%` change the filter.

**Search, filters, sort.** Client-side. Search is a substring match on
`[first_name, last_name, email, phone].join(" ")`, so "Maria Alv" matches
across the two name fields; placeholder "Search name, email, phone…" (the
e2e clients journey finds the box by this text). One toggle, a native
"Show inactive" checkbox. Sorting is TanStack client-side on `name`
(`last, first` lower-cased), `contact` (email else phone) and `noShows`;
paging client-side at 10 with `:show-rows-per-page="false"`.

**Gate.** `definePageMeta` permission `clients.view`; `can('clients.create')`
shows "New client", `can('clients.edit')` the pencil. Nav and command
palette gate on `clients.view`.

**Table.** `UiTanStackTable` (the stock ui-thing file, 837 lines, kept
upstream-identical by a comment on the page) with slots `#name-cell`
(NuxtLink to the profile, strikethrough when inactive, "Card on file
required" line), `#contact-cell`, `#noShows-cell` (red badge when > 0),
`#actions-cell`. The component already accepts `manualPagination`,
`manualSorting`, `manualFiltering` and `pageCount` and emits
`update:pagination` / `update:sorting`; no page uses them, and it has no
`rowCount`, `page` or `sortingState` props (the three Lokl added).

**Unit test.** `tests/pages/clients.test.ts` stubs the query chain with
only `select, order, eq, neq, is, then`; a page that calls `.rpc()` or
`.range()` breaks the stub, so the test moves with the page.

## 2. `/products` — `apps/reserve/app/pages/products.vue` (exists, 448 lines)

**Load.** `useAsyncData("products-list")`:
`from("products").select("id, name, description, sku, price_cents,
cost_cents, stock_quantity, taxable, active").order("name")`. All rows,
active and inactive; `cost_cents` is fetched for every viewer although the
Margin column shows only under `products.manage` (RLS does not hide
columns). No limit, so the 1,000 cap applies; `checkout.vue` loads every
active product the same way.

**Search, filters, sort.** Client-side substring over `name`, `sku` and
`description` (the placeholder says "Search name, SKU…", so description
matching is undocumented). "Show inactive" toggle. TanStack sort on
`product`, `price`, `margin` (only when `manage`), `stock`.

**Gate.** Permission `products.view`; `can("products.manage")` controls
"New product", the Margin column and the actions cell (edit,
activate/deactivate). Writes go through the browser client under RLS:
update, insert with `organization_id` from `rpc("current_org_id")`, the
active toggle.

**Shows.** Product, Price, Margin (manage only), Stock (red at 0, amber at
≤ 5), actions.

## 3. Transactions on `/financials` — `apps/reserve/app/pages/financials.vue` (1,264 lines)

**Load.** `useAsyncData(() => \`fin-ledger-${fetchKey}\`)` with
`watch: [fetchKey]`:

```ts
.from("transactions")
.select(`id, created_at, total_cents, subtotal_cents, discount_cents, tax_cents, tip_cents,
         refunds_transaction_id, note,
         clients(first_name, last_name),
         cashier:staff!transactions_checked_out_by_fkey(display_name),
         transaction_items(kind, staff_id, name_snapshot, quantity, total_cents, tax_cents),
         payments(method, amount_cents, reference)`)
.order("created_at", { ascending: false })
.gte("created_at", range.value.from.toISOString())
.lt("created_at", range.value.to.toISOString());
```

The SAME array feeds the summary cards (`money`), the per-provider
revenue and tips in the utilization table, and the Transactions table.
Six more queries on the page: appointments in range, active bookable
staff, every `availability_rules` row, approved exceptions overlapping the
range, `gift_cards` balances (all active cards, summed in the browser),
and the previous period's ledger (no `.order()`, so which rows survive a
cap is undefined).

**Cap.** No `.limit()` anywhere on this page. A month or year with more
than 1,000 transactions truncates newest-first, and the cards sum the
truncated set. Gift-card liability is capped at 1,000 active cards.

**Period.** Day / Week / Month / Year buttons plus a `UiDatepicker`
range; picking dates sets `period = "custom"`. The range is computed on
the BROWSER clock: `setHours(0,0,0,0)`, week from `from.getDay()` (Sunday
start), month `setDate(1)`, year `setMonth(0,1)`; custom is inclusive
end date + 1. Period state is page-local refs, not the URL. The
utilization math expands `availability_rules` (stored location-local)
with `cursor.getDay()` and `setHours(sh, sm)` on the browser clock too.
Neither `useLocationTimezone()` nor `shared/time/zone.ts` is used.

**Search, filters, sort.** Client-side search over client full name (or
"Walk-in"), cashier name, note, the total as `"123.45"`, every item
`name_snapshot`, and payment method label + reference; placeholder
"Search client, item, amount, reference…". `METHOD_LABELS` has no
`stripe_card` entry, so Stripe payments render and search as the raw
string. TanStack sort on `when`, `client`, `total`; paging at 10.

**Gate.** Permission `financials.view_summary`; `can("pos.refund")`
inside `refundable()`, which also checks `refundedIds` built only from the
loaded period (a refund issued in a later period is not seen; the
original shows as refundable and the server answers 409).

**Gate mismatch.** The page is gated on `financials.view_summary`, but
RLS on what it reads needs `transactions.view` (transactions, items,
payments), `gift_cards.view` and `staff.view`, plus `appointments.view.any`.
A role holding `view_summary` without `transactions.view` sees $0
everywhere with no error. Seeded roles: admin and super_admin hold all;
front_desk holds `transactions.view` but not `view_summary`; provider
holds neither.

**Also:** `/transactions` (`transactions.vue`) is a separate page, gated on
`transactions.view`, a `<ul>` list of "the most recent 50" with
`.limit(50)`, no search, filter, sort or paging; anything older is
unreachable from it. It embeds `GiftCardsSection` (all gift cards, no
limit, client-side search on code, purchaser and recipient).

## 4. RLS on the tables the pages read

Helpers (`init_org_auth_permissions.sql`), all `security definer stable
set search_path = public`: `current_staff_id()` (the active staff row for
`auth.uid()`), `current_org_id()` (that row's organisation),
`has_permission(perm)` (exists in `staff_roles` × `role_permissions` for
the current staff). `is_admin()` (`marketing_campaigns_phase1.sql`) is the
same shape, true for the `admin` and `super_admin` roles.

| Table | Read policy (USING) | Writes |
| --- | --- | --- |
| `clients` | `organization_id = current_org_id() and has_permission('clients.view')` | insert `clients.create`, update `clients.edit`, delete `clients.delete`, all org-scoped |
| `products` | `… and has_permission('products.view')` | `products_manage` for all, `… and has_permission('products.manage')` (USING doubles as the check) |
| `transactions` | `… and has_permission('transactions.view')` | NONE: append-only by omission; writes only through the checkout, refund and cancel routes under the service role |
| `transaction_items` | `exists (select 1 from transactions t where t.id = transaction_id and t.organization_id = current_org_id() and has_permission('transactions.view'))` | none |
| `payments` | same shape as items | none |
| `gift_cards` | `… and has_permission('gift_cards.view')` | none |
| `staff` | `… and has_permission('staff.view')` | invite / edit / self-update |

Grants (`explicit_api_grants.sql`): `select, insert, update, delete on all
tables … to anon, authenticated`; the ledger's append-only property rests
entirely on the absence of policies. No text-search extension or index
exists: `btree_gist`, `pg_cron` and `pg_net` are the only extensions;
clients has `clients_org_name (organization_id, last_name, first_name)` and
`clients_org_email (organization_id, lower(email))`; transactions has
`transactions_org_day (organization_id, created_at desc)` and
`transactions_client`; items and payments have their `transaction_id`
indexes; products and gift_cards have only their unique constraints.
`config.toml` has `extra_search_path = ["public", "extensions"]`.

## 5. Every place that computes money today, and its definition of revenue

The ledger's constraints: `transactions` has
`check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents)`,
one timestamp (`created_at`, no `completed_at`), no sign constraint.
`transaction_items.kind in ('service','product','gift_card','tip','discount','late_cancellation_fee')`
(the fee added in communications phase 4, with the column comment
"revenue, but not service or retail revenue, so it stays out of the
'services + retail' reporting sums by kind"). `payments.method in
('card_external','gift_card','cash','stripe_card')`.

How rows are written: checkout stores `discount_cents` POSITIVE on the
header while discount items are NEGATIVE, and `subtotal` INCLUDES gift
card sales. A refund is a full negative mirror (header, items with the
same kind and staff_id, payments), stamped with the refund's own
`created_at`, so it lands in the period it was ISSUED. A late-cancellation
fee is a transaction with one `late_cancellation_fee` item, no tax, no
`staff_id`, paid by `stripe_card`, `checked_out_by` the system staff row.

| Place | What counts as revenue | Discounts | Tips | Gift card sales | Late fees | Refunds | Tax | Date, zone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `financials.vue` `money` (cards: Revenue, Tips, Discounts, Tax, Gift cards sold, Refunds, Transactions, Avg ticket) | `service` + `product` item `total_cents` | NOT subtracted (shown as a separate card from `transactions.discount_cents`) | separate card, "pass-through to providers" | excluded; "sold this period" card | in NO card; only inside txn count and avg ticket | netted through the mirror items; the Refunds card is `-total_cents` of refund rows (includes refunded tax, tips, gift cards) | separate card | `created_at`, browser clock, Sunday-start week |
| `financials.vue` per-provider (utilization table) | `service` items by `item.staff_id` | not allocated | `tip` items by `staff_id` | — | not attributed (no staff_id) | netted | — | same; only active, bookable staff appear, so a deactivated provider's revenue drops out |
| `financials.vue` previous period | same as `money` | same | same | same | same | same | same | same; its local `trend()` has no baseline floor and differs from the shared `app/utils/trend.ts` |
| `KpiCards.vue` "Revenue (7 days)" | `service` + `product` | not subtracted | excluded | excluded | excluded | netted | excluded | `created_at`, rolling 7 days from browser-local midnight (not a calendar week); no limit, no order: capped at 1,000 |
| `BookingsChart.vue` | no money; counts non-cancelled appointments by day | — | — | — | — | — | — | browser clock (its own comment says so) |
| `FrontDeskToday.vue` "paid" | has a non-refund transaction for the appointment | — | — | — | — | a refunded original still counts as paid | — | — |
| `GiftCardsSection.vue` / financials liability | `sum(balance_cents)` over active cards, all-time | — | — | — | — | — | — | — |
| Ask preset `financials.revenue_this_month` | every kind EXCEPT `gift_card`, grouped by kind (tip, discount and late fee each get a row) | a negative row | a row | excluded | a row | netted | excluded | `date_trunc('month', now())`, DB session zone (UTC on Supabase) |
| Ask preset `clients.top_spenders_quarter` | `sum(total_cents) where total_cents > 0` | — | included | included | included | excluded (gross) | included | UTC quarter |
| Ask preset `staff.revenue_by_provider_month` | `service` items by `staff_id`, all staff | — | — | — | — | netted | — | UTC month |
| Ask preset `financials.gift_cards_outstanding` | lists only UNTOUCHED cards (`balance = initial`) | — | — | — | — | — | — | — |
| Ask schema prompt (what the LLM is told) | "exclude `gift_card`"; also "a plain SUM over transactions already nets them out — that is usually what someone means by revenue" (which includes tax, tips and gift card sales, contradicting the previous bullet); the kind list omits `late_cancellation_fee` | | | | | | | `date_trunc` in session zone; ISO weeks start Monday |

No SQL view or function aggregates money; every total is computed in the
browser or inside an Ask preset. `migration4a-design.md` says
"sum(payments) = transactions.total … asserted by trigger"; no such
trigger or constraint exists in any migration.

**Do the existing places agree?** The two UI places — the financials
cards and the KPI card — AGREE: revenue is `service` + `product` item
totals, pre-tax, gross of discounts, net of refunds (via the negative
mirror items), excluding tips, gift card sales and late-cancellation fees.
Everything else disagrees with them: the Ask revenue preset includes tip,
discount and fee rows; the Ask prompt calls a plain transaction SUM
"revenue"; top spenders is gross and includes tax and tips; gift-card
"outstanding" means two different things in Ask and in the UI. The
late-cancellation fee appears in no UI total at all. Bucketing happens in
three different zones (browser, browser-rolling, UTC) with two week
starts (Sunday in the UI, Monday in Ask). Financials and KpiCards are
missing from the board's browser-clock inventory.

## 6. Infrastructure already in place

- `shared/time/zone.ts`: `tzOffsetMs`, `localToUtc(dateKey, "HH:MM", tz)`,
  `dayOfWeek`, `zonedParts`, `localDateKey`, `minutesIntoDay`, `timeLabel`,
  `shortTime`; tested in `tests/shared/zone.test.ts`. No "start of
  week/month in a zone" helper yet. `useLocationTimezone()` reads the
  first location's zone once per app.
- Composables: `useAsk`, `useAuth`, `useIsAdmin`, `useLeadQueue`,
  `useLocationTimezone`, `usePermissions` (`can(key)` from
  `get_my_permissions`), `useProspectQueue`, `useStartConversation`,
  `useToast`, `useToggleSet`. No table composable.
- Versions: Nuxt 4.5.0, `@tanstack/vue-table` ^9.2.4 (same major as
  Lokl), zod ^4.4.3 (used for forms through `toTypedSchema`).
- Harnesses: `verify-ask`, `verify-forms`, `verify-leads`, `verify-messages`,
  `verify-presets` in `scripts/`, on `_env.mjs` with the localhost guard.
  `verify-messages.mjs` is the shape to copy: tagged fixtures,
  `staffMember()` makes an auth user AND a real session with the anon key,
  `check()` counts both directions, a `CANNOT CONNECT` exit, a
  two-organisation check that runs only under `LOCAL_MODE` (its
  second-org staff have no sessions, so it exercises triggers, not RLS
  from the other org's point of view — an RLS two-org check needs
  sessions in both).
- Unit tests under `apps/reserve/tests/` (vitest, nuxt environment, node
  per file where marked); none for products, financials, transactions,
  KpiCards or any money rollup.
- E2E: three journeys; `TestData` builders for staff, clients, the
  location's zone, a service and hours; no ledger, product or gift-card
  builders, and the money-journey cleanup decision (test org versus
  tagged rows) is still open in `docs/testing-design.md`.

## 7. Findings the design has to carry

1. Silent truncation at `max_rows` on every one of these pages; on
   financials it corrupts the totals.
2. All search/filter/sort/page is client-side; the table component
   already has the manual-mode props it needs except `rowCount`, `page`,
   `sortingState`.
3. The UI's two revenue definitions agree; Ask's three do not match them,
   and late fees are in no total. One definition has to be written down
   and shared.
4. Financials buckets on the browser clock with a Sunday week; it belongs
   on the location's zone through `shared/time/zone.ts`.
5. The `financials.view_summary` gate does not imply the RLS keys the
   page needs; a custom role sees zeros silently.
6. `/clients` ships DOB, address and emergency contact to the browser for
   a list view.
7. `METHOD_LABELS` lacks `stripe_card`; the forms client search
   interpolates unescaped input; `migration4a-design.md` claims a trigger
   that does not exist.
