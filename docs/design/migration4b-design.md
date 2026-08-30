# Migration 4b — Stripe: Design

STATUS: SHIPPED 2026-08-29 (mini-gauntlet verified in test mode).
This document records the design as decided and built. Decisions were
locked in the 4b design session; deviations discovered during the build
are noted inline as [AS-BUILT].

Decisions locked from Q&A (all five ratified as recommended):

1. **Tenancy**: single platform Stripe account. Keys live in env/config only —
   no per-org assumptions baked into schema or code paths, so a future Stripe
   Connect retrofit (SaaS path) is bounded. Matches the multi-tenancy decision
   log: "change nothing now, keep the door open."
2. **Consent**: front-desk-attested v1. Saving a card requires a
   `card_consents` row snapshotting the policy TEXT at capture time (the
   price-snapshot principle applied to legal language). Client-facing capture
   (signature/email confirmation) can upgrade this in the intake-forms phase
   without schema change — it's a new `method` value.
3. **Mirror**: minimal. `stripe_customer_id` on clients; display fields only
   (brand, last4, expiry) in `client_payment_methods`. Stripe's dashboard is
   the source of truth for card/charge detail; OUR ledger is the source of
   truth for what was sold. Nothing else is mirrored.
4. **Charge flow**: synchronous. The checkout route confirms the PaymentIntent
   and only writes the ledger on success — a transaction row still means
   settled truth, preserving 4a's immutability semantics. The webhook route
   RECONCILES (refund confirmations, disputes, timeout edge cases); it does
   not drive ledger writes.
   [FUTURE EXCEPTION — memberships]: subscription dues will arrive via
   invoice.paid webhooks; that phase makes the webhook a ledger writer for
   that one transaction kind. See docs/design/memberships-notes.md.
5. **Refunds**: automatic push to card on the Refund action, loud failure.
   The refund route calls stripe.refunds.create against the original
   PaymentIntent BEFORE the negative mirror is written; a Stripe failure
   aborts the whole refund (no ledger row) so ledger and money never
   disagree.

## Schema (migration: stripe_cards)

- `clients.stripe_customer_id` — lazily created on first Stripe interaction.
- `card_consents` — client, captured_by (staff), method
  ('front_desk_attested' now; 'client_signed' later), policy_text snapshot,
  timestamp. Append-only.
- `client_payment_methods` — stripe_payment_method_id + display fields
  (brand, last4, exp_month/year), consent_id (NOT NULL: no card without
  consent, enforced by schema), active flag (detached cards deactivate,
  never delete — historical payments reference them).
- `payments` gains method `stripe_card` and `stripe_payment_intent_id`
  with a presence check: stripe_card rows MUST carry it, others must not.
  [AS-BUILT]: this constraint caught the refund route's negated-payment
  map omitting the intent id before it shipped — refund rows carry the
  ORIGINAL intent id (provenance: the refund row points at what it
  reversed).
- `stripe_events` — processed webhook event ids (idempotency: Stripe
  retries deliveries; each event applies at most once). Service-role only.
- Permissions: `cards.view`, `cards.manage` (front desk and up). Charging
  stays under `pos.checkout`; refund-to-card under `pos.refund`.
- RLS: reads by permission; ALL writes through server routes.

## Flows

### Save a card (client profile — ClientCards.vue)

1. "Add card" → consent checkbox displaying the policy text GATES the
   card form: checking it fires POST /api/clients/[id]/setup-intent,
   which ensures the Customer exists (create + store id on first use)
   and returns a SetupIntent client_secret
   (payment_method_types=['card']).
2. Stripe **Card Element** collects the card and confirmCardSetup runs —
   the PAN never touches our server (SAQ-A scope).
   [AS-BUILT]: Card Element, NOT Payment Element. The Payment Element
   layers Stripe Link's remember-me autofill onto the card method, which
   is wrong for a front-desk terminal (staff enter the CLIENT's card;
   Link binds cards to the browser/operator). The classic Card Element
   has no Link, no wallets, by construction.
3. POST /api/clients/[id]/payment-methods VERIFIES the SetupIntent with
   Stripe (status=succeeded AND customer matches this client — never
   trust the browser), then writes consent row + mirror row (in that
   order; the NOT NULL forces it). Staff identity via current_staff_id()
   RPC.

### Charge at checkout

1. When the selected client has active saved cards, the Payment section
   offers charge-method radios: each saved card ("Card on file — visa
   •••• 4242") vs "Card terminal (external)". Front desk picks —
   multi-card clients get a human choice, no default-card flag needed.
2. POST /api/checkout — a stripe_card payment carries paymentMethodId.
   The route verifies OWNERSHIP (the pm belongs to this client and is
   active — a forged id 422s), then AFTER all validation and BEFORE any
   ledger write: paymentIntents.create with customer + payment_method,
   off_session=true, confirm=true, amount from the SAME server-computed
   math the ledger records.
   - Success → txn/items/payments written exactly as 4a does, the
     payment row carrying stripe_payment_intent_id. One card charge per
     checkout (v1).
   - Failure (decline/expired/3DS-required) → 402 with Stripe's message;
     NOTHING written. Front desk falls back to the physical terminal
     (card_external — the 4a path stays fully alive).
3. New-card-at-checkout punts in v1: save via the profile flow
   (~30 seconds), then charge. One Elements integration, not two.

### Webhook (POST /api/stripe/webhook)

- Signature verification against the RAW body (readRawBody, not parsed
  JSON) before anything.
- Idempotency: insert event id into stripe_events; 23505 conflict → 200
  duplicate. ANY OTHER insert failure → 500 so Stripe redelivers.
  [AS-BUILT]: the first version returned 200 on all insert failures — a
  clock-skew incident ("JWT issued at future") exposed that this
  silently dropped events; inverted to fail-loud.
- v1 handlers: payment_intent.succeeded = reconciliation only (a success
  with NO matching ledger row is the timeout edge → error log + admin
  notification through the notifications rail); charge.dispute.created →
  admin notification with response deadline; payment_method.detached →
  deactivate mirror row; payment_method updated/automatically_updated →
  refresh brand/last4/expiry.
- Always 200 fast; handler errors are logged, never fail the response
  (the event is recorded; redelivery would be skipped as duplicate).
- Dev: stripe CLI listen --forward-to localhost:3000/api/stripe/webhook
  (CLI whsec\_ is stable per login). PROD: register the endpoint in the
  dashboard — it issues its OWN signing secret (deploy checklist).

### Refund

- If the original transaction has stripe_card payments: for each,
  stripe.refunds.create(payment_intent, amount) FIRST; only on success
  proceed to the negative-mirror ledger writes. Gift/external portions
  behave exactly as 4a (gift balance restore via trigger; external card
  refunded manually on the physical terminal).

### Card removal

- POST /api/clients/[id]/payment-methods/[rowId]/detach: permission +
  ownership check → stripe.paymentMethods.detach (card becomes
  unchargeable) → mirror row active=false. The webhook's detached
  handler also deactivates (belt and suspenders); doing it in-route
  makes the UI immediate. ClientCards row gains an × with inline
  confirm (financials idiom). Deactivated cards vanish from checkout's
  radios and the profile list via the active filter.

## Config

- STRIPE*SECRET_KEY + STRIPE_WEBHOOK_SECRET: runtimeConfig TOP LEVEL
  (server-only). NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: runtimeConfig.public.
  The boundary rule, learned twice in one night: public = browser =
  pk*/publishable material ONLY; sk*/whsec* never in a NUXT*PUBLIC* var
  or the public block.
- Test mode: magic cards — 4242 4242 4242 4242 (succeeds),
  4000 0000 0000 0002 (declines at attach), 4000 0000 0000 0341
  (attaches, declines on charge).

## Not in 4b (deferred)

- Stripe Terminal (physical reader) — card_external + existing terminal
  keep working alongside.
- Subscriptions — memberships (§3), on these rails.
- Client-facing payment surfaces (online booking deposits).
- The cancellation-fee ENGINE — 4b built its enabler (consented card on
  file); the policy engine is its own phase.
- Duplicate-card fingerprint guard; consent policy text → business
  settings (both on the punch list in docs/TODO.md).
