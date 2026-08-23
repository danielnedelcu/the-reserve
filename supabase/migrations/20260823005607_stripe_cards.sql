-- ============================================================
-- DRAFT — Migration 4b: Stripe (card-on-file + in-app charging)
-- Review together, then: npx supabase migration new stripe_cards
-- ============================================================

-- ------------------------------------------------------------
-- Clients gain their Stripe identity (lazily created — null until
-- the client's first Stripe interaction)
-- ------------------------------------------------------------
alter table clients add column stripe_customer_id text unique;
comment on column clients.stripe_customer_id is
  'Stripe Customer id (cus_...). Created lazily by the setup-intent route on first card save. Single platform Stripe account; a future Connect retrofit would add an account dimension here.';

-- ------------------------------------------------------------
-- CARD CONSENTS — the requirements'' card-on-file consent,
-- captured as data. Append-only; policy text is SNAPSHOTTED
-- (same principle as price snapshots: later policy edits never
-- rewrite what a client actually agreed to).
-- ------------------------------------------------------------
create table card_consents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  client_id       uuid not null references clients(id),
  captured_by     uuid not null references staff(id),
  method          text not null default 'front_desk_attested'
                    check (method in ('front_desk_attested','client_signed')),
  policy_text     text not null,
  created_at      timestamptz not null default now()
);
comment on table card_consents is
  'Consent records for storing a card on file (cancellation-fee enabler). Append-only: no update/delete policies. method=front_desk_attested is v1; client_signed arrives with intake forms. policy_text is a snapshot of the exact language shown at capture.';

create index card_consents_client on card_consents (client_id, created_at desc);

-- ------------------------------------------------------------
-- CLIENT PAYMENT METHODS — the minimal mirror. Card data lives
-- in Stripe; we store ONLY what the UI needs to display and what
-- the charge flow needs to reference.
-- ------------------------------------------------------------
create table client_payment_methods (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organizations(id),
  client_id                 uuid not null references clients(id),
  consent_id                uuid not null references card_consents(id),
  stripe_payment_method_id  text not null unique,
  brand                     text not null,   -- visa, mastercard, amex, ...
  last4                     text not null,
  exp_month                 int  not null check (exp_month between 1 and 12),
  exp_year                  int  not null,
  active                    boolean not null default true,
  created_at                timestamptz not null default now()
);
comment on table client_payment_methods is
  'Display-fields-only mirror of Stripe PaymentMethods (pm_...). consent_id is NOT NULL: no card exists without a consent record. Detached/expired cards are deactivated (active=false), never deleted — historical payments may reference them.';

create index client_payment_methods_client
  on client_payment_methods (client_id) where active;

-- ------------------------------------------------------------
-- PAYMENTS: stripe_card joins the tender enum, and rows carry
-- the PaymentIntent id (the refund route''s handle)
-- ------------------------------------------------------------
alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('card_external','gift_card','cash','stripe_card'));

alter table payments add column stripe_payment_intent_id text;
comment on column payments.stripe_payment_intent_id is
  'Set on method=stripe_card rows (pi_...). The refund route calls stripe.refunds.create against this. The sync charge flow guarantees it: ledger rows are written only after the PaymentIntent succeeds.';

-- stripe_card payments must carry their intent; other methods must not
alter table payments add constraint payments_stripe_intent_presence
  check ((method = 'stripe_card') = (stripe_payment_intent_id is not null));

-- ------------------------------------------------------------
-- WEBHOOK IDEMPOTENCY — Stripe retries deliveries; every event
-- applies at most once. The webhook route inserts first, and a
-- conflict means "already processed, 200 and done."
-- ------------------------------------------------------------
create table stripe_events (
  id           text primary key,            -- Stripe event id (evt_...)
  type         text not null,
  processed_at timestamptz not null default now()
);
comment on table stripe_events is
  'Processed Stripe webhook event ids for idempotency. Insert-on-arrival; unique violation = duplicate delivery, skip. Service-role only (no policies).';

-- ------------------------------------------------------------
-- PERMISSIONS
-- ------------------------------------------------------------
insert into permissions (key, description) values
  ('cards.view',   'See a client''s saved cards (brand + last4)'),
  ('cards.manage', 'Save and remove client cards on file (with consent capture)');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'cards.view'), ('super_admin', 'cards.manage'),
  ('admin',       'cards.view'), ('admin',       'cards.manage'),
  ('front_desk',  'cards.view'), ('front_desk',  'cards.manage')
) as p(role_name, key) on p.role_name = r.name;

-- ------------------------------------------------------------
-- RLS — reads by permission; ALL writes through server routes
-- (service role). No authenticated insert/update/delete policies:
-- consent capture and card saves are multi-step acts with Stripe
-- calls in the middle, so they live in routes, same as the ledger.
-- ------------------------------------------------------------
alter table card_consents          enable row level security;
alter table client_payment_methods enable row level security;
alter table stripe_events          enable row level security;

create policy card_consents_read on card_consents
  for select using (organization_id = current_org_id() and has_permission('cards.view'));

create policy client_payment_methods_read on client_payment_methods
  for select using (organization_id = current_org_id() and has_permission('cards.view'));

-- stripe_events: no policies at all — service role only.