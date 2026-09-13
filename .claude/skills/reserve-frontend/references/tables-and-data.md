# Tables, and how values are rendered

## The TanStack recipe

Columns are plain objects with an `id`, an `accessorFn`, and a
**plain-string `header`** — not a render function, unless you genuinely need
markup in the header.

```ts
const cardColumns = [
  { id: "code",    accessorFn: (card: CardRow) => card.code,            header: "Code",      enableSorting: true },
  { id: "balance", accessorFn: (card: CardRow) => card.balance_cents,   header: "Remaining", enableSorting: true },
];
```
(`app/components/GiftCardsSection.vue:72-90`)

- Prefer `accessorFn` over `accessorKey`: it survives a column rename, keeps
  the type checked, and lets a derived value (`purchaserName(card)`) be a
  first-class column.
- Give every column an explicit `id`. With `accessorFn` there is no key to
  infer one from, and sorting and pinning both address columns by id.
- Cell markup goes in a **`#<id>-cell`** slot on the table — note the
  order, `#code-cell` not `#cell-code` — not in the column definition. The
  component builds the name from the column id itself
  (`` :name="`${cell.column.id}-cell`" ``, `Ui/TanStackTable.vue:131`), so
  the column's `id` IS the slot prefix and a renamed id silently orphans
  its slot: the column falls back to the raw accessor value rather than
  erroring. That is also why every column needs an explicit `id`.
  Keeping markup in slots leaves the column list readable as a schema:

```vue
<UiTanStackTable :data="cards" :columns="cardColumns">
  <template #code-cell="{ row }">…</template>
  <template #balance-cell="{ row }">…</template>
</UiTanStackTable>
```
(`app/components/GiftCardsSection.vue:143-230`; 19 cell slots across
products.vue, financials.vue, clients/index.vue and GiftCardsSection.vue
all follow this shape.)

There is also a **`#footer="{ table }"`** slot for totals rows, scoped to
the table instance so it can read the current page's rows
(`app/pages/financials.vue:1117`).

**`Ui/TanStackTable.vue` is the STOCK upstream file. Do not customise it
in place.** It once carried a hand-added sticky header
(`class="sticky top-0 z-10 bg-card/95 backdrop-blur-sm"` on the header
row); on 2026-09-12 it was reset to what `npx ui-thing@latest add
tanstacktable` ships, so that command stays a clean overwrite. A page that
wants a sticky header styles it FROM THE PAGE, through the wrapper's
descendant variants — `app/pages/clients/index.vue` is the reference:

```vue
<!-- page root owns the viewport (layout header is h-12) -->
<div class="flex h-[calc(100dvh-3rem)] flex-col p-6 md:p-10">
  <div class="shrink-0">…title…</div>
  <div class="shrink-0">…toolbar…</div>
  <!-- the card may SHRINK (min-h-0, no grow); it never stretches past its rows -->
  <div class="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card
    [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-col
    [&>div:last-child]:shrink-0
    **:data-[slot=table-container]:min-h-0 **:data-[slot=table-container]:overflow-y-auto
    **:data-[slot=table-head]:sticky **:data-[slot=table-head]:top-0 **:data-[slot=table-head]:z-10
    **:data-[slot=table-head]:bg-card **:data-[slot=table-head]:shadow-[inset_0_-1px_0_var(--border)]
    [&_thead_tr]:border-b-0">
    <UiTanStackTable … />
  </div>
</div>
```

What each piece does, because each one silently fails alone:

- **No fixed height anywhere.** A `max-h-[70vh]` cap was the first version;
  it made a two-row table leave the pager floating and a long one stop at
  an arbitrary line. Instead the page root has the viewport height and is
  a flex column, everything above the table is `shrink-0`, and the card is
  `min-h-0` WITHOUT `flex-1`: it shrinks to the remaining space when rows
  overflow (rows scroll inside it, pager pinned at the window's bottom
  edge) and stays content-sized when they do not (pager directly under the
  last row). Verified 2026-09-12 at 600px, 1000px and with a two-row
  filter (clients) and a one-row filter (products): gap last-row→pager 0,
  no page scroll in any case.
- **The constraint has to reach the scroll container.** `UiTanStackTable`
  renders a fragment — a table wrapper `<div class="relative">` and the
  pager `<div>` as siblings — so the card addresses them with
  `[&>div:first-child]` / `[&>div:last-child]`, and the table's own
  `data-slot=table-container` gets `overflow-y-auto`. Every ancestor in the
  chain needs `min-h-0`, or one of them refuses to shrink and nothing
  scrolls. And NO floor on the container: a `min-h-48` there padded a
  one-row list to 192px and left a 68px gap above the pager — the exact
  thing this layout exists to prevent. A very short window compresses the
  table instead, which is the rarer case and still scrolls.
- **`overflow-hidden` on a rounded card.** The sticky cells are square and
  carry their own background, so at the top corners they paint over the
  border's curve; clipping the card's children to its rounded shape fixes
  it and leaves sticky alone (sticky positions against the nearest
  SCROLLING ancestor, which is still the table container).
- **Sticky goes on the `<th>`s** (`table-head`), not the `<thead>`: under
  collapsed table borders a sticky thead loses its bottom border in
  Chrome, so the line is an inset shadow on each cell — and the header
  row's own `border-b` (from `UiTableHeader`'s `[&_tr]:border-b`) must be
  turned off with `[&_thead_tr]:border-b-0`, or shadow and border stack
  into a 2px divider at rest. The background is required, or rows show
  through as they scroll under.

Verify by shrinking the viewport until the container scrolls (10 rows at
desktop height often do not) and reading the header's offset from the
container top after scrolling — it should be 0 — then filter to two rows
and read the gap between the last row and the pager — it should be 0 too.

That reset also moved the project to **TanStack Table v9** (`@tanstack/vue-table`
9.x): the upstream component is written against it and does not compile
on v8 (`columnPinningFeature`, `createSortedRowModel`, `useTable`, pin
positions `start`/`end` — none exist in v8, which is what "errors in the
browser" after the add looked like). Two v9 facts that reached consumers:

- **State is read through atoms, not `getState()`.** A `#footer` slot that
  paged by hand reads `table.atoms.pagination.get().pageIndex`, not
  `table.getState().pagination.pageIndex` (`app/pages/financials.vue`, the
  utilization footer).
- **`header: ""` is a hydration mismatch.** v8's `flexRender` returned
  null for any falsy header; v9 only short-circuits on `null`/`undefined`,
  so an empty string becomes an empty text node on the client that the
  server never emitted — Vue reports it on every page with an actions
  column. Leave `header` OUT for a header-less column
  (`{ id: "actions", enableSorting: false }`); the three actions columns
  were changed this way.

Paging size is a `UiSelect`, so it is string-valued; see the computed in
`Ui/TanStackTable.vue:689`.

## The rendering contract — suffix decides display

`shared/ask/format.ts` is the single source of truth for turning a database
value into something a person reads. **The COLUMN NAME decides**, by suffix:

| suffix | renders as | example |
| --- | --- | --- |
| `_cents` | currency | `35641` → `$356.41` |
| `_at` | a date | `2026-09-06T…` → `Sep 6, 2026` |
| `_id` | an entity chip / link | client id → the client's name, linked |

(`shared/ask/format.ts:199-212`)

Two rules follow:

**Name columns for how they should read.** A money column that is not called
`*_cents` will render as a bare integer, and the fix is the name, not a
special case at the call site.

**Never format money in two places.** Caption and table once formatted
`_cents` separately and drifted — a single-cell result read
"Avg spend: 4064" above `$356.41`-style formatting in the table. Fixed in
42290e5 by making both call the same contract. This is the two-paths
convention in `CLAUDE.md`; the rendering contract is its worked example.

## Dates — two different jobs

**Day KEYS** (grouping, comparing, storing a day): `toLocaleDateString("en-CA")`,
which yields `YYYY-MM-DD` in local time. Never `toISOString()` — it converts
to UTC first and lands on the wrong day for anyone west of Greenwich
(`CLAUDE.md`).

**Human DISPLAY**: a readable format, `month: "short"` style —
`new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })`
→ `Sep 6, 2026` (`GiftCardsSection.vue:105`). `shared/ask/format.ts` does the
same for `_at` columns, so table and caption agree.

Do not use the key format for display or the display format as a key.
