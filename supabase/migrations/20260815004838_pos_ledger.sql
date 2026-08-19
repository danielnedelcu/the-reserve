-- ============================================================
-- DRAFT — Migration 4a: POS & Payments (ledger, products, gift cards)
-- Review together, then: npx supabase migration new pos_ledger
-- ============================================================

-- ------------------------------------------------------------
-- Location tax rate (Georgia: retail taxable, services not)
-- ------------------------------------------------------------
alter table locations add column tax_rate_bps int not null default 0
  check (tax_rate_bps between 0 and 3000);
comment on column locations.tax_rate_bps is
  'Sales tax in basis points (800 = 8%). Applied to taxable transaction items (retail); services are non-taxable in GA.';

-- ------------------------------------------------------------
-- PRODUCTS (retail)
-- ------------------------------------------------------------
create table products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  description     text,
  sku             text,
  price_cents     int not null check (price_cents >= 0),
  cost_cents      int check (cost_cents >= 0),
  stock_quantity  int not null default 0,
  taxable         boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
comment on table products is
  'Retail catalog (lotions, candles, ...). Stock decremented by trigger on sale. cost_cents enables margin reporting. Deactivated, never deleted.';

create trigger trg_products_touch
  before update on products
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------
-- GIFT CARDS (a card is a LIABILITY: selling one is not revenue;
-- redeeming it is)
-- ------------------------------------------------------------
create table gift_cards (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id),
  code                 text not null unique,
  initial_balance_cents int not null check (initial_balance_cents > 0),
  balance_cents        int not null check (balance_cents >= 0),
  purchaser_client_id  uuid references clients(id),
  recipient_name       text,
  recipient_email      text,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);
comment on table gift_cards is
  'Balance maintained by triggers: created/loaded by a gift_card SALE item, decremented by a gift_card PAYMENT. Balance can never go negative (trigger).';

-- ------------------------------------------------------------
-- THE LEDGER
-- ------------------------------------------------------------
create table transactions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id),
  location_id            uuid not null references locations(id),
  client_id              uuid references clients(id),        -- null = walk-in retail
  appointment_id         uuid references appointments(id),   -- when checkout came from a visit
  refunds_transaction_id uuid references transactions(id),   -- set on refund transactions
  subtotal_cents         int not null,
  discount_cents         int not null default 0,
  tax_cents              int not null default 0,
  tip_cents              int not null default 0,
  total_cents            int not null,
  checked_out_by         uuid not null references staff(id),
  note                   text,
  created_at             timestamptz not null default now(),
  check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents)
);
comment on table transactions is
  'The immutable money ledger: one row per checkout. NEVER updated or deleted (no policies exist). Refunds are new rows with negative amounts referencing the original via refunds_transaction_id. All financial reporting reads from here.';

create index transactions_org_day on transactions (organization_id, created_at desc);
create index transactions_client on transactions (client_id, created_at desc);

create table transaction_items (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete restrict,
  kind           text not null check (kind in ('service','product','gift_card','tip','discount')),
  -- source links (per kind; others null)
  appointment_id uuid references appointments(id),
  product_id     uuid references products(id),
  gift_card_id   uuid references gift_cards(id),
  staff_id       uuid references staff(id),   -- provider attribution: service + tip lines
  name_snapshot  text not null,
  quantity       int not null default 1 check (quantity > 0),
  unit_price_cents int not null,              -- negative for discount lines
  taxable        boolean not null default false,
  tax_cents      int not null default 0,
  total_cents    int not null,                -- quantity * unit_price (pre-tax)
  discount_reason text
);
comment on table transaction_items is
  'Line items with name/price SNAPSHOTS (catalog edits never rewrite sold history). kind=service carries appointment + staff attribution; kind=tip carries staff attribution for payroll reads; kind=discount is negative; kind=gift_card is a liability sale, excluded from revenue reporting.';

create index transaction_items_txn on transaction_items (transaction_id);
create index transaction_items_staff on transaction_items (staff_id) where staff_id is not null;

create table payments (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete restrict,
  method         text not null check (method in ('card_external','gift_card','cash')),
  -- 4b adds: 'stripe_card', 'stripe_card_on_file'
  amount_cents   int not null,               -- negative on refund transactions
  gift_card_id   uuid references gift_cards(id),
  reference      text,                        -- external terminal receipt #, etc.
  created_at     timestamptz not null default now(),
  check ((method = 'gift_card') = (gift_card_id is not null))
);
comment on table payments is
  'How each transaction settled. Multiple rows = split tender ("$80 gift card + rest on card"). card_external = charged on the spa''s existing physical terminal and recorded here; in-app charging arrives with Stripe (4b).';

create index payments_txn on payments (transaction_id);

-- ------------------------------------------------------------
-- INTEGRITY TRIGGERS
-- ------------------------------------------------------------

-- Gift card redemption: decrement, never below zero.
create or replace function apply_gift_card_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.method = 'gift_card' then
    update gift_cards
      set balance_cents = balance_cents - new.amount_cents
      where id = new.gift_card_id and active;
    if not found then
      raise exception 'Gift card not found or inactive';
    end if;
    -- balance_cents >= 0 check constraint turns overdrafts into errors
  end if;
  return new;
end $$;
create trigger trg_gift_card_payment
  after insert on payments
  for each row execute function apply_gift_card_payment();

-- Product stock: decrement on sale (floor at zero rather than block —
-- physical inventory drifts; the sale already happened at the counter).
create or replace function apply_product_sale()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'product' and new.product_id is not null then
    update products
      set stock_quantity = greatest(stock_quantity - new.quantity, 0)
      where id = new.product_id;
  end if;
  return new;
end $$;
create trigger trg_product_sale
  after insert on transaction_items
  for each row execute function apply_product_sale();

-- ------------------------------------------------------------
-- PERMISSIONS (new keys + role grants)
-- ------------------------------------------------------------
insert into permissions (key, description) values
  ('pos.checkout',      'Ring up transactions at checkout'),
  ('pos.refund',        'Issue refunds'),
  ('transactions.view', 'View the transaction ledger'),
  ('products.view',     'View the retail product catalog'),
  ('products.manage',   'Create/edit/deactivate retail products'),
  ('gift_cards.view',   'Look up gift cards and balances');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'pos.checkout'), ('super_admin', 'pos.refund'),
  ('super_admin', 'transactions.view'), ('super_admin', 'products.view'),
  ('super_admin', 'products.manage'), ('super_admin', 'gift_cards.view'),
  ('admin', 'pos.checkout'), ('admin', 'pos.refund'),
  ('admin', 'transactions.view'), ('admin', 'products.view'),
  ('admin', 'products.manage'), ('admin', 'gift_cards.view'),
  ('front_desk', 'pos.checkout'), ('front_desk', 'transactions.view'),
  ('front_desk', 'products.view'), ('front_desk', 'gift_cards.view'),
  ('provider', 'products.view')
) as p(role_name, key) on p.role_name = r.name;

-- ------------------------------------------------------------
-- RLS — reads by permission; WRITES ONLY THROUGH THE CHECKOUT/
-- REFUND SERVER ROUTES (service role): no authenticated insert
-- policies on the ledger, and no update/delete policies at all.
-- ------------------------------------------------------------
alter table products          enable row level security;
alter table gift_cards        enable row level security;
alter table transactions      enable row level security;
alter table transaction_items enable row level security;
alter table payments          enable row level security;

create policy products_read on products
  for select using (organization_id = current_org_id() and has_permission('products.view'));
create policy products_manage on products
  for all using (organization_id = current_org_id() and has_permission('products.manage'));

create policy gift_cards_read on gift_cards
  for select using (organization_id = current_org_id() and has_permission('gift_cards.view'));

create policy transactions_read on transactions
  for select using (organization_id = current_org_id() and has_permission('transactions.view'));
create policy transaction_items_read on transaction_items
  for select using (exists (select 1 from transactions t where t.id = transaction_id
    and t.organization_id = current_org_id() and has_permission('transactions.view')));
create policy payments_read on payments
  for select using (exists (select 1 from transactions t where t.id = transaction_id
    and t.organization_id = current_org_id() and has_permission('transactions.view')));