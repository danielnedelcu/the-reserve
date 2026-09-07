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
  (`` :name="`${cell.column.id}-cell`" ``, `Ui/TanStackTable.vue:160`), so
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

Sticky headers are classes on the header row, not a prop:

```vue
class="sticky top-0 z-10 bg-card/95 backdrop-blur-sm"
```
(`Ui/TanStackTable.vue:17`) — the background is required, or rows show
through as they scroll under it.

Paging size is a `UiSelect`, so it is string-valued; see the computed in
`Ui/TanStackTable.vue:727`.

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
