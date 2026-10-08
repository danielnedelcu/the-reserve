# Ledger integrity — atomic writes, idempotency, enforced invariants

STATUS: approved 2026-10-07 (rulings 1–7 below); PR 1 BUILT 2026-10-08; PR 2 BUILT 2026-10-08 (as-built notes inline). Two later changes, same day, recorded where they land below: the block function became the shared `append_only_block()` (audit_log carries it too), and the lines' and payments' single-column keys to transactions were replaced by composite keys when they gained their own `organization_id` (policy-sweep-design.md, PR 2).

## Why

migration4a-design.md said `sum(payments) = transactions.total` was
"asserted by trigger". It never was. Investigating that (2026-10-07) found
the larger gap: the three ledger writers — checkout, refund, the
late-cancellation fee — each write header, lines and payments as THREE
PostgREST requests with hand-written compensating deletes. A crash between
requests leaves a header with no lines or no payments, and the deletes that
tidy up are ledger deletes under the service role, which the "append-only
by absence of policies" rule does not stop. The hosted ledger is consistent
today (11 transactions, every candidate invariant zero violations, checked
read-only), because nothing has crashed mid-write yet.

## Decisions (rulings, 2026-10-07)

1. **Atomic writes.** One SQL function, `write_ledger_transaction`,
   security definer, `set search_path = public`, execute granted to
   service_role only. The route passes the organisation explicitly with
   its rows. Routes keep every pricing decision and every Stripe call in
   TypeScript and call the function ONCE after the charge or refund has
   succeeded. The compensating deletes go.
2. **Idempotent.** `transactions.idempotency_key` (text, not null) with a
   unique index on `(organization_id, idempotency_key)`. A retry after a
   lost response returns the existing transaction's id and writes nothing;
   a key that already exists returns before the line and payment inserts,
   so the gift-card and stock triggers never run twice. Keys:
   - checkout with a Stripe charge: `pi:<payment_intent_id>`;
   - checkout without one (cash, external card, gift card): the page
     mints `crypto.randomUUID()` when the cart is opened and keeps it until
     a checkout succeeds; the body carries it; the key is
     `checkout:<uuid>`;
   - refund: `refund:<original_transaction_id>` — one refund per original
     is the rule already (409), and the key makes it a unique conflict.
     The Stripe refund is created with Stripe's own idempotency key,
     `reserve-refund-<original_transaction_id>`, so a retry does not
     refund twice before reaching the ledger;
   - late-cancellation fee: `pi:<payment_intent_id>`.
   Existing rows are backfilled with `legacy:<id>`.
3. **Invariants, as deferred constraint triggers checked at commit** (so
   the function may insert in any order inside one transaction), plus
   one immediate check:
   - payments balance: `sum(payments) = total_cents`, and
     `total_cents = 0 ⇔ no payment rows`;
   - lines balance: `sum(service, product, gift_card,
     late_cancellation_fee lines) = subtotal_cents`,
     `sum(discount lines) = -discount_cents`, `sum(tip lines) = tip_cents`,
     `sum(line tax_cents) = tax_cents`, and at least one line;
   - refund mirror: a transaction with `refunds_transaction_id` negates
     its original field for field, its lines' and payments' sums and
     counts negate the original's, there is one refund per original, and
     a refund is never itself refunded. **This forbids partial refunds**,
     which 4a's design described and the code never built; relax it
     deliberately when they are built;
   - `transaction_items.total_cents = quantity * unit_price_cents`, a
     plain CHECK (immediate).
   `total = subtotal - discount + tax + tip` is already a CHECK.
4. **Append-only, for every role.** A trigger raising on UPDATE and DELETE
   on all three ledger tables, with no role exemption — the service role
   included. TRUNCATE revoked from service_role on the three tables.
   Local test and seed cleanup bypass the trigger ONLY through the direct
   `postgres` connection behind the localhost guard (`session_replication_role`
   or `alter table … disable trigger`), never through the API.
5. **Foreign keys** — inventory and rulings below.
6. **Two PRs.** PR 1: the function, the key, the three writers moved onto
   it, compensating deletes removed, Stripe idempotency keys; no change in
   behaviour. PR 2: the triggers, the check, the append-only block, the
   TRUNCATE revoke, and the `verify-ledger` harness.
7. **Board:** a Stripe test-mode harness for the fee writer; orphaned
   REFUNDS (a Stripe refund that succeeds before its ledger write fails is
   not flagged by the webhook, which only reconciles `payment_intent.succeeded`).

## Foreign keys (read from hosted, 2026-10-07)

Out of the ledger — all `on delete no action`, `on update no action`:

| child.column | parent | what a parent delete does today | ruling |
| --- | --- | --- | --- |
| transactions.organization_id | organizations | fails (23503) | keep; organisations are never deleted |
| transactions.location_id | locations | fails | keep; `locations_manage` allows delete, so a location with sales cannot be removed — deactivate it instead (no UI deletes one) |
| transactions.client_id | clients | fails | keep; `clients_delete` exists for `clients.delete` but no UI calls it; a client with transactions is deactivated, never deleted |
| transactions.appointment_id, transaction_items.appointment_id | appointments | fails | keep; no delete policy; appointments are cancelled |
| transactions.checked_out_by, transaction_items.staff_id | staff | fails | keep; no delete policy; staff are deactivated |
| transaction_items.product_id | products | fails | keep; `products_manage` allows delete, the UI deactivates; a sold product cannot be removed |
| transaction_items.gift_card_id, payments.gift_card_id | gift_cards | fails | keep; no delete policy |
| transactions.refunds_transaction_id | transactions | fails | keep; the block refuses the delete first anyway |

Into the ledger: `transaction_items.transaction_id` and
`payments.transaction_id` are `on delete restrict` (keep); the refund
self-reference is `no action` (keep).

So: NO cascade and NO set null reaches the ledger from anywhere. A parent
delete with ledger children fails on its own foreign key before the block
is reached, and nothing changes. The rule for the app is stated here so it
is not rediscovered: **anything a transaction points at is deactivated,
never deleted.** The e2e cleanup deletes clients and appointments under
the service role, which is fine only while journeys write no ledger rows
(they do not; docs/testing-design.md, the money-journey decision).

`[AS-BUILT]` PR 2 (2026-10-08, ruled at stop 1): the eleven `no action`
keys are now `restrict`, stated — the outward keys: six on
`transactions` (organisation, location, client, appointment, cashier,
the refund self-reference), four on `transaction_items` (appointment,
product, gift card, staff), one on `payments` (gift card). All eleven
remain, verified against hosted 2026-10-08. The two line-to-transaction
keys were never among them (already `restrict` from 4a); later the same
day (ledger_organization, policy-sweep-design.md PR 2) those two were
DROPPED and replaced by composite keys on `(transaction_id,
organization_id)` referencing `transactions (id, organization_id)`,
still `restrict`, because keeping both made PostgREST refuse every
embedded select. Thirteen restrict keys on the three tables in all. The app offers no delete of a client,
staff member, product, location, appointment or gift card today; the
`clients_delete`, `products_manage` and `locations_manage` policies stay
as they are (a direct API delete of a record with sales history fails on
the foreign key, 23503). **Any future delete UI for those records must
check ledger history first and offer deactivate instead, with a plain
explanation — never let the foreign-key error reach the screen.** A
client with sales history also cannot be erased on request: see the
board's client-data-erasure item (anonymise the record, keep the row).

## The write function (PR 1)

```
write_ledger_transaction(
  p_organization_id uuid,
  p_idempotency_key text,
  p_header   jsonb,   -- location_id, client_id, appointment_id,
                      -- refunds_transaction_id, subtotal_cents,
                      -- discount_cents, tax_cents, tip_cents, total_cents,
                      -- checked_out_by, note
  p_items    jsonb,   -- array of transaction_items rows (no transaction_id)
  p_payments jsonb    -- array of payments rows (no transaction_id)
) returns uuid
```

Inserts the header `on conflict (organization_id, idempotency_key) do
nothing`; on conflict it compares the request with what the key wrote —
the total, and canonical fingerprints of the lines (kind, product,
appointment, gift card, staff, quantity, unit price, total) and of the
payments (method, amount, gift card), each sorted — and returns the
existing id only if they match (`LD001` otherwise, so an edited cart
under a reused key is refused rather than silently lost). Otherwise it
inserts the lines and the payments from the arrays and returns the new
id. All in the function's one transaction: a failure anywhere — a
gift-card overdraft raised by the payments trigger included — rolls
everything back and the route gets the error with nothing written.
Unknown JSON keys raise `22023` (a misspelt nullable column would
otherwise become a silent null); any referenced row from another
organisation raises `LD002`. The money math stays in the routes until
PR 2's triggers take it over at commit.

`[AS-BUILT]` PR 1 (migration 20261008014201_ledger_atomic_write,
`server/utils/ledgerWrite.ts`, `scripts/verify-ledger.mjs`, 27 cases):
- The routes map `LD001` to 409 with the first transaction's id in
  `data.transactionId`, `LD002` to 404, anything else to 500. The checkout
  page shows staff the first sale went through and only then mints a new
  per-cart key.
- A checkout that SELLS gift cards creates the `gift_cards` rows before
  the write. On a retry the route finds the key's transaction first and
  reuses its gift-card lines' ids, so no second card is minted and the
  fingerprint compares equal.
- A genuine checkout retry returns before the audit row and the receipt,
  which went out the first time.
- The saved-card charge is created under Stripe idempotency key
  `reserve-checkout-<cart key>`, so a retry reaches the same
  PaymentIntent and the ledger key `pi:<intent>` dedups the write.
- The refund route keeps its "already refunded" 409 BEFORE the Stripe
  refund, so a second click never reaches Stripe; the function's
  `refund:<original>` key is the backstop. The 409 carries the mirror's
  id and the page shows it as "already refunded" with a link, not as a
  failure. The Stripe refund carries `reserve-refund-<original>-<intent>`.
  **Recovery window:** if the Stripe refund succeeds and the ledger write
  then fails, a retry recovers through Stripe's idempotency key — Stripe
  returns the same refund rather than issuing a second — only within
  Stripe's 24-hour idempotency window. After that a retry would refund
  twice, and the webhook does not flag an orphaned refund today (board:
  the Stripe test-mode harness and orphaned-refund reconciliation).
- The fee writer is proven by calling the function with its exact rows
  (a `late_cancellation_fee` line and a `stripe_card` payment carrying
  the intent, keyed `pi:<intent>`), not by driving the cancel route
  (board: Stripe test-mode harness).
- The verify-tables ledger fixtures and the load seed still insert the
  three tables directly (they are not app writers); each now carries a
  `fixture:` / `seed:` key.

## Proof

- PR 1: checkout and refund driven through their routes on the local
  stack with real sessions, before and after, rows compared field for
  field (the harness `verify-ledger.mjs`, local only since it writes
  ledger rows); the fee writer by calling the function with the fee's
  exact rows, because driving the cancel route needs a Stripe test-mode
  card and charge (board). A retry with the same key returns the same id
  and leaves one transaction.
- PR 2: for each trigger, an unbalanced set inside one transaction is
  rejected at commit with the trigger's message and a balanced set is
  accepted; an update and a delete on each table are refused for the
  service role; the three real writers' rows pass.

## PR 2 as built (migration 20261008021248_ledger_integrity)

- `assert_ledger_transaction(uuid)` checks a whole transaction; deferred
  constraint triggers on all three tables call it for the transaction a
  new row belongs to, at COMMIT. Rules by name in the error (`LD010`):
  `ledger.lines`, `ledger.subtotal`, `ledger.discount`, `ledger.tip`,
  `ledger.tax`, `ledger.zero_total`, `ledger.payments`,
  `ledger.refund_header` (money negated; client, appointment and location
  equal), `ledger.refund_lines`, `ledger.refund_payments`,
  `ledger.refund_of_refund`. Security definer, execute revoked from
  public, anon and authenticated; only the triggers call it.
- One refund per original: a partial unique index on
  `refunds_transaction_id` (23505), structural.
- `transaction_items.total_cents = quantity * unit_price_cents`: an
  immediate CHECK (23514).
- Append-only for every role: the block trigger raises `LD003` on
  update or delete on all three tables, an ORIGIN trigger so the service
  role is bound too. TRUNCATE revoked from service_role (TRUNCATE fires
  no row trigger; the privilege is what covers it). `[AS-BUILT]` Built
  as `ledger_block_change`; replaced the same day by the shared
  `append_only_block()`, whose message names the table, when `audit_log`
  took the same trigger (audit_log_organization) — the three ledger
  triggers were recreated onto it and the old function dropped.
- Fixtures and seed: the verify-tables ledger fixture and the load seed
  insert through the direct postgres connection, each transaction (or
  batch) inside one begin…commit with the triggers ACTIVE, so they are
  proof as well as data; `write_ledger_transaction` takes no created_at,
  which back-dated fixtures need. Cleanup — verify-tables, verify-ledger,
  the seed's `--clean` — sets `session_replication_role = replica` inside
  one transaction on that connection, behind the localhost guard. The
  API roles have no such path.
- Proof: verify-ledger grew to cover every rule (an unbalanced write
  rejected at commit with the rule's name and nothing surviving, the
  balanced one accepted), the second refund, the refund of a refund,
  update/delete/truncate under the service role through the API and on
  a direct connection, the permission error for a session calling
  `assert_ledger_transaction`, and a client's deletion refused with
  history and allowed without; the real writers still pass through their
  routes and the fee's exact rows.

## Deliberately deferred

- Partial refunds (the mirror forbids them; see decision 3).
- A Stripe test-mode harness for the fee path and for orphaned refunds
  (board).
- Moving the money math itself into SQL: the routes' 422s stay the first
  line; the triggers are the last.
