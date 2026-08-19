# Migration 4a — POS & Payments: Design

Decisions locked from Q&A:

- **Tax (Georgia)**: retail goods taxable; services not. → items carry a
  `taxable` flag + computed `tax_cents`; the rate lives on the location
  (`tax_rate_bps`, basis points: 8% = 800). Services/gift cards/tips default
  non-taxable; products default taxable.
- **Discounts**: minimal — a `discount` line-item kind (negative amount,
  reason text). No coupon engine.
- **Tender** ("tender" = how the customer pays): business is card/electronic
  only. Until Stripe lands (4b), card charges happen on the spa's EXISTING
  terminal and are RECORDED here as method `card_external` (with an optional
  reference for the terminal receipt #). Gift-card redemption is the other 4a
  tender. `cash` is included in the enum anyway (costs nothing; refunds/edge
  cases happen), Stripe methods arrive in 4b. Split tender supported:
  N payments per transaction.
- **Permissions**: new keys `pos.checkout`, `pos.refund`, `transactions.view`,
  `products.view`, `products.manage`, `gift_cards.view`. Checkout = front desk
  and up; refunds = admin and up; catalog manage = admin and up.
- **Receipts**: digital only — email receipt at checkout via the existing
  mailer (server-route step, template in the brand shell). No print path.

## Shape

transactions (1) ── transaction_items (N) ── payments (N)

- **transactions**: the checkout event. org/location/client (nullable for
  walk-in retail), who rang it up, money rollups (subtotal, discount, tax,
  tip, total), created_at. IMMUTABLE once written: no update/delete policies.
- **transaction_items**: what was sold. `kind`: service | product | gift_card
  | tip | discount. Snapshots name + unit price; links to its source
  (appointment_id for services, product_id, gift_card_id). `staff_id` on
  service and tip lines = provider attribution (revenue-per-provider and
  future payroll reads come from here).
- **payments**: how it settled. method: card_external | gift_card | cash
  (| stripe_* in 4b). gift_card_id when redeeming. Sum(payments) must equal
  transactions.total — enforced in the checkout route, asserted by trigger.

## Refunds

A refund is a NEW transaction with negative amounts, `refunds_transaction_id`
pointing at the original. Originals are never edited. Requires `pos.refund`.
Partial refunds = refund transaction containing only the refunded lines.

## Money integrity rules (enforced by trigger, not just app code)

1. total = subtotal - discount + tax + tip on every transaction.
2. sum(payments.amount) = transactions.total.
3. Gift card balance never below zero (redemption trigger).
4. Product stock decremented on sale (floor at zero, warn don't block).

## Flows (4a)

- **Checkout** (server route `POST /api/checkout`): cart in → validate,
  price from catalog/products (never trust client), compute tax on taxable
  lines, apply tip + discounts, write txn + items + payments atomically,
  triggers maintain gift-card balances & stock, email receipt, audit_log row.
- **Gift card sale**: a `gift_card` item creates the gift_cards row (code
  generated) — sale is liability, not revenue (reporting reads kinds).
- **Gift card redemption**: a `gift_card` payment decrements balance.
- **Checkout entry points**: a "Checkout" action on a completed appointment
  (pre-fills service lines + provider) and a standalone POS page for retail.

## Deferred to 4b (Stripe)

stripe_customer_id on clients; SetupIntents + consent capture (card on file);
PaymentIntents at checkout (method `stripe_card`); webhook route as source of
truth; Terminal hardware later still.
