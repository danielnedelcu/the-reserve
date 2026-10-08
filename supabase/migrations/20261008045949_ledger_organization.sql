-- ============================================================
-- Migration: the ledger's own organization_id (policy sweep PR 2)
-- npx supabase migration new ledger_organization
-- docs/design/policy-sweep-design.md, "The ledger's organization_id"
--
-- transaction_items and payments carried no organisation of their own,
-- so their read policies looked up the parent transaction PER LINE —
-- about 90ms of every year-wide transactions_page call on the 50k seed.
-- Each now carries organization_id, kept equal to its transaction's by a
-- composite foreign key (a line in another organisation cannot exist, by
-- reference, with no trigger to keep it right), and the two read policies
-- become the plain column check, transactions_read's shape.
--
-- THE ONE-TIME EXCEPTION. The ledger is append-only for every role
-- (append_only_block, ledger_integrity 2026-10-08) and a backfill is an
-- UPDATE. This migration disables the two child tables' append-only
-- triggers BY NAME, runs one UPDATE each from the parent transaction,
-- re-enables them, and asserts in the same transaction that both are
-- enabled again (pg_trigger.tgenabled = 'O') and that no row is left
-- null — raising otherwise, which rolls the whole migration back. It is
-- the first UPDATE to existing ledger rows since the legacy: idempotency
-- keys (ledger_atomic_write), and the only one sanctioned.
-- session_replication_role = replica is NOT used: it would also skip the
-- foreign-key checks. No other trigger on either table fires on UPDATE —
-- trg_product_sale, trg_gift_card_payment and the three balance triggers
-- are AFTER INSERT only (inventoried on hosted 2026-10-08) — so the
-- backfill runs nothing else against the existing rows.
-- Disabling a trigger takes an ACCESS EXCLUSIVE lock on its table and the
-- migration runs in one transaction, so no other session can write to
-- either table while the append-only triggers are off.
-- Hosted at the time of writing: 11 transactions, 18 lines, 13 payments,
-- one organisation, every invariant passing.
--
-- [AS-BUILT] The single-column keys transaction_items_transaction_id_fkey
-- and payments_transaction_id_fkey are DROPPED once the composite keys
-- exist, not kept as the design first said. With both, PostgREST sees
-- two relationships between transactions and each child and refuses
-- every embedded select (PGRST201, "more than one relationship was
-- found"): the refund route, the checkout's gift-card read and the
-- transactions page all embed transaction_items and payments, and all
-- three broke on the first local run. The composite key carries the
-- same ON DELETE RESTRICT and implies the single column's reference, so
-- nothing is lost; one key, one relationship, no hint needed anywhere.
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE COLUMNS, AND WHAT THE COMPOSITE KEY REFERENCES
-- ------------------------------------------------------------
-- The unique constraint on (id, organization_id) exists only so the
-- composite foreign keys below have something to reference; id alone
-- is already the primary key.
alter table transactions add constraint transactions_id_org_unique unique (id, organization_id);
alter table transaction_items add column organization_id uuid;
alter table payments          add column organization_id uuid;

-- ------------------------------------------------------------
-- 2. THE BACKFILL — the one sanctioned exception (header)
-- ------------------------------------------------------------
do $$
declare
  v_lines     int;
  v_payments  int;
  v_enabled   int;
  v_null_l    int;
  v_null_p    int;
begin
  alter table transaction_items disable trigger trg_transaction_items_append_only;
  alter table payments          disable trigger trg_payments_append_only;

  update transaction_items i set organization_id = t.organization_id
    from transactions t where t.id = i.transaction_id;
  get diagnostics v_lines = row_count;
  update payments p set organization_id = t.organization_id
    from transactions t where t.id = p.transaction_id;
  get diagnostics v_payments = row_count;

  alter table transaction_items enable trigger trg_transaction_items_append_only;
  alter table payments          enable trigger trg_payments_append_only;

  select count(*) into v_enabled from pg_trigger
   where tgname in ('trg_transaction_items_append_only', 'trg_payments_append_only')
     and tgenabled = 'O';
  if v_enabled <> 2 then
    raise exception 'ledger_organization: the append-only triggers are not both re-enabled (% of 2) — rolling back', v_enabled;
  end if;
  select count(*) into v_null_l from transaction_items where organization_id is null;
  select count(*) into v_null_p from payments where organization_id is null;
  if v_null_l > 0 or v_null_p > 0 then
    raise exception 'ledger_organization: % line(s) and % payment(s) resolved to no organisation — rolling back', v_null_l, v_null_p;
  end if;
  raise notice 'ledger_organization: backfilled % line(s) and % payment(s); both append-only triggers enabled again', v_lines, v_payments;
end $$;

-- ------------------------------------------------------------
-- 3. NOT NULL, THE COMPOSITE KEYS, THE INDEXES
-- ------------------------------------------------------------
-- The composite key is the consistency rule: (transaction_id,
-- organization_id) must be a row of transactions. It replaces the
-- single-column key on transaction_id (same restrict on the parent; see
-- the header for why the two cannot coexist).
alter table transaction_items
  alter column organization_id set not null,
  add constraint transaction_items_transaction_org_fkey
    foreign key (transaction_id, organization_id)
    references transactions (id, organization_id) on delete restrict;
alter table payments
  alter column organization_id set not null,
  add constraint payments_transaction_org_fkey
    foreign key (transaction_id, organization_id)
    references transactions (id, organization_id) on delete restrict;

alter table transaction_items drop constraint transaction_items_transaction_id_fkey;
alter table payments          drop constraint payments_transaction_id_fkey;

create index transaction_items_org_txn on transaction_items (organization_id, transaction_id);
create index payments_org_txn          on payments          (organization_id, transaction_id);

comment on column transaction_items.organization_id is
  'The line''s own organisation, always equal to its transaction''s by the composite foreign key (transaction_id, organization_id) → transactions (id, organization_id). Set by write_ledger_transaction; backfilled once from the parent by ledger_organization (2026-10-08), the ledger''s one sanctioned UPDATE. Read policy is the plain column check.';
comment on column payments.organization_id is
  'The payment''s own organisation, always equal to its transaction''s by the composite foreign key (transaction_id, organization_id) → transactions (id, organization_id). Set by write_ledger_transaction; backfilled once from the parent by ledger_organization (2026-10-08). Read policy is the plain column check.';

-- ------------------------------------------------------------
-- 4. THE WRITER — replaced whole from ledger_write_header_compare;
--    the only change is organization_id = p_organization_id on every
--    line and payment it inserts (two insert column lists, two selects).
-- ------------------------------------------------------------
create or replace function write_ledger_transaction(
  p_organization_id uuid,
  p_idempotency_key text,
  p_header          jsonb,
  p_items           jsonb,
  p_payments        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id              uuid;
  v_existing        transactions%rowtype;
  v_bad_keys        text;
  v_total           int;
  v_lines_asked     jsonb;
  v_lines_stored    jsonb;
  v_payments_asked  jsonb;
  v_payments_stored jsonb;
  c_header_keys   constant text[] := array[
    'location_id','client_id','appointment_id','refunds_transaction_id',
    'subtotal_cents','discount_cents','tax_cents','tip_cents','total_cents',
    'checked_out_by','note'];
  c_item_keys     constant text[] := array[
    'kind','appointment_id','product_id','gift_card_id','staff_id',
    'name_snapshot','quantity','unit_price_cents','taxable','tax_cents',
    'total_cents','discount_reason'];
  c_payment_keys  constant text[] := array[
    'method','amount_cents','gift_card_id','reference','stripe_payment_intent_id'];
begin
  -- ---- shape -----------------------------------------------------------
  if p_organization_id is null or coalesce(p_idempotency_key, '') = '' then
    raise exception 'write_ledger_transaction: organisation and idempotency key are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_header) <> 'object' then
    raise exception 'write_ledger_transaction: header must be an object' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'write_ledger_transaction: a transaction needs at least one line'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_payments) <> 'array' then
    raise exception 'write_ledger_transaction: payments must be an array' using errcode = '22023';
  end if;

  -- ---- unknown keys: a misspelt nullable column would otherwise become a silent null
  select string_agg(k, ', ') into v_bad_keys
    from jsonb_object_keys(p_header) k where k <> all (c_header_keys);
  if v_bad_keys is not null then
    raise exception 'write_ledger_transaction: unknown header key(s): %', v_bad_keys
      using errcode = '22023';
  end if;
  select string_agg(distinct k, ', ') into v_bad_keys
    from jsonb_array_elements(p_items) e, jsonb_object_keys(e) k where k <> all (c_item_keys);
  if v_bad_keys is not null then
    raise exception 'write_ledger_transaction: unknown line key(s): %', v_bad_keys
      using errcode = '22023';
  end if;
  select string_agg(distinct k, ', ') into v_bad_keys
    from jsonb_array_elements(p_payments) e, jsonb_object_keys(e) k where k <> all (c_payment_keys);
  if v_bad_keys is not null then
    raise exception 'write_ledger_transaction: unknown payment key(s): %', v_bad_keys
      using errcode = '22023';
  end if;

  -- ---- organisation consistency: every row this transaction points at is ours
  if not exists (select 1 from locations
                 where id = (p_header->>'location_id')::uuid and organization_id = p_organization_id) then
    raise exception 'write_ledger_transaction: location is not in this organisation' using errcode = 'LD002';
  end if;
  if not exists (select 1 from staff
                 where id = (p_header->>'checked_out_by')::uuid and organization_id = p_organization_id) then
    raise exception 'write_ledger_transaction: checked_out_by is not in this organisation' using errcode = 'LD002';
  end if;
  if p_header->>'client_id' is not null and not exists (select 1 from clients
                 where id = (p_header->>'client_id')::uuid and organization_id = p_organization_id) then
    raise exception 'write_ledger_transaction: client is not in this organisation' using errcode = 'LD002';
  end if;
  if p_header->>'appointment_id' is not null and not exists (select 1 from appointments
                 where id = (p_header->>'appointment_id')::uuid and organization_id = p_organization_id) then
    raise exception 'write_ledger_transaction: appointment is not in this organisation' using errcode = 'LD002';
  end if;
  if p_header->>'refunds_transaction_id' is not null and not exists (select 1 from transactions
                 where id = (p_header->>'refunds_transaction_id')::uuid and organization_id = p_organization_id) then
    raise exception 'write_ledger_transaction: the refunded transaction is not in this organisation' using errcode = 'LD002';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items)
      as i(appointment_id uuid, product_id uuid, gift_card_id uuid, staff_id uuid)
    where (i.staff_id       is not null and not exists (select 1 from staff        where id = i.staff_id       and organization_id = p_organization_id))
       or (i.product_id     is not null and not exists (select 1 from products     where id = i.product_id     and organization_id = p_organization_id))
       or (i.appointment_id is not null and not exists (select 1 from appointments where id = i.appointment_id and organization_id = p_organization_id))
       or (i.gift_card_id   is not null and not exists (select 1 from gift_cards   where id = i.gift_card_id   and organization_id = p_organization_id))
  ) then
    raise exception 'write_ledger_transaction: a line points at another organisation' using errcode = 'LD002';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_payments) as p(gift_card_id uuid)
    where p.gift_card_id is not null
      and not exists (select 1 from gift_cards where id = p.gift_card_id and organization_id = p_organization_id)
  ) then
    raise exception 'write_ledger_transaction: a payment points at another organisation' using errcode = 'LD002';
  end if;

  -- ---- what this request asks for, as canonical fingerprints, for the
  -- retry comparison: the lines by what was sold and for how much, the
  -- payments by tender and amount, each sorted so order never matters.
  v_total := (p_header->>'total_cents')::int;
  select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into v_lines_asked
    from (
      select jsonb_build_object(
        'kind', i.kind, 'product_id', i.product_id, 'appointment_id', i.appointment_id,
        'gift_card_id', i.gift_card_id, 'staff_id', i.staff_id,
        'quantity', coalesce(i.quantity, 1), 'unit_price_cents', i.unit_price_cents,
        'total_cents', i.total_cents) as f
      from jsonb_to_recordset(p_items) as i(
        kind text, product_id uuid, appointment_id uuid, gift_card_id uuid, staff_id uuid,
        quantity int, unit_price_cents int, total_cents int)
    ) s;
  select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into v_payments_asked
    from (
      select jsonb_build_object('method', p.method, 'amount_cents', p.amount_cents, 'gift_card_id', p.gift_card_id) as f
      from jsonb_to_recordset(p_payments) as p(method text, amount_cents int, gift_card_id uuid)
    ) s;

  -- ---- the header; a reused key stops here
  insert into transactions (
    organization_id, idempotency_key,
    location_id, client_id, appointment_id, refunds_transaction_id,
    subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents,
    checked_out_by, note
  )
  select
    p_organization_id, p_idempotency_key,
    (p_header->>'location_id')::uuid,
    (p_header->>'client_id')::uuid,
    (p_header->>'appointment_id')::uuid,
    (p_header->>'refunds_transaction_id')::uuid,
    (p_header->>'subtotal_cents')::int,
    coalesce((p_header->>'discount_cents')::int, 0),
    coalesce((p_header->>'tax_cents')::int, 0),
    coalesce((p_header->>'tip_cents')::int, 0),
    v_total,
    (p_header->>'checked_out_by')::uuid,
    p_header->>'note'
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- A key already written. A genuine retry asks for the same sale and
    -- gets the same answer; an edited cart under the old key — a new
    -- total, a product swapped for another at the same price, a
    -- different tender — is refused, so the first sale is never
    -- silently overwritten or lost.
    select * into v_existing from transactions
      where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
    select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into v_lines_stored
      from (
        select jsonb_build_object(
          'kind', kind, 'product_id', product_id, 'appointment_id', appointment_id,
          'gift_card_id', gift_card_id, 'staff_id', staff_id,
          'quantity', quantity, 'unit_price_cents', unit_price_cents,
          'total_cents', total_cents) as f
        from transaction_items where transaction_id = v_existing.id
      ) s;
    select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into v_payments_stored
      from (
        select jsonb_build_object('method', method, 'amount_cents', amount_cents, 'gift_card_id', gift_card_id) as f
        from payments where transaction_id = v_existing.id
      ) s;
    -- Compared: total, subtotal, discount, tax, tip, client, appointment,
    -- the refunded original, the lines and the payments. NOT compared:
    -- checked_out_by, location_id and note — a colleague retrying the
    -- same cart is the same sale.
    if v_existing.total_cents <> v_total
       or v_existing.subtotal_cents is distinct from (p_header->>'subtotal_cents')::int
       or v_existing.discount_cents is distinct from coalesce((p_header->>'discount_cents')::int, 0)
       or v_existing.tax_cents is distinct from coalesce((p_header->>'tax_cents')::int, 0)
       or v_existing.tip_cents is distinct from coalesce((p_header->>'tip_cents')::int, 0)
       or v_existing.client_id is distinct from (p_header->>'client_id')::uuid
       or v_existing.appointment_id is distinct from (p_header->>'appointment_id')::uuid
       or v_existing.refunds_transaction_id is distinct from (p_header->>'refunds_transaction_id')::uuid
       or v_lines_stored <> v_lines_asked
       or v_payments_stored <> v_payments_asked then
      raise exception
        'write_ledger_transaction: key % already wrote transaction % with a different header, lines or payments',
        p_idempotency_key, v_existing.id
        using errcode = 'LD001', detail = v_existing.id::text;
    end if;
    return v_existing.id;
  end if;

  -- ---- the lines
  insert into transaction_items (
    transaction_id, organization_id, kind, appointment_id, product_id, gift_card_id, staff_id,
    name_snapshot, quantity, unit_price_cents, taxable, tax_cents, total_cents, discount_reason
  )
  select
    v_id, p_organization_id, i.kind, i.appointment_id, i.product_id, i.gift_card_id, i.staff_id,
    i.name_snapshot, coalesce(i.quantity, 1), i.unit_price_cents,
    coalesce(i.taxable, false), coalesce(i.tax_cents, 0), i.total_cents, i.discount_reason
  from jsonb_to_recordset(p_items) as i(
    kind text, appointment_id uuid, product_id uuid, gift_card_id uuid, staff_id uuid,
    name_snapshot text, quantity int, unit_price_cents int, taxable boolean,
    tax_cents int, total_cents int, discount_reason text
  );

  -- ---- the payments (the gift-card trigger decrements balances here;
  -- an overdraft rolls the whole write back)
  insert into payments (
    transaction_id, organization_id, method, amount_cents, gift_card_id, reference, stripe_payment_intent_id
  )
  select v_id, p_organization_id, p.method, p.amount_cents, p.gift_card_id, p.reference, p.stripe_payment_intent_id
  from jsonb_to_recordset(p_payments) as p(
    method text, amount_cents int, gift_card_id uuid, reference text, stripe_payment_intent_id text
  );

  return v_id;
end $$;

-- ------------------------------------------------------------
-- 5. THE READ POLICIES — the plain column check
-- ------------------------------------------------------------
alter policy transaction_items_read on transaction_items
  using (organization_id = (select current_org_id()) and (select has_permission('transactions.view')));
alter policy payments_read on payments
  using (organization_id = (select current_org_id()) and (select has_permission('transactions.view')));

-- ------------------------------------------------------------
-- 6. THE VIEW — organization_id from the line's own column
-- ------------------------------------------------------------
-- Same columns in the same order and types, so create or replace is
-- enough and ledger_transactions (which reads transactions) is untouched.
create or replace view ledger_lines
with (security_invoker = true)
as
select
  i.id,
  i.transaction_id,
  i.organization_id,                          -- the line's own column (ledger_organization), no longer the parent's
  t.location_id,
  t.client_id,
  t.checked_out_by,
  i.appointment_id,
  i.product_id,
  i.gift_card_id,
  i.staff_id,
  i.kind,
  i.name_snapshot,
  i.quantity,
  i.unit_price_cents,
  i.total_cents,
  i.tax_cents,
  i.discount_reason,
  t.created_at,
  t.refunds_transaction_id,
  (t.refunds_transaction_id is not null)                                      as is_refund,
  -- THE categories. A refund's mirror lines are negative, so every sum
  -- over these is net of refunds with nothing filtered by sign.
  case when i.kind in ('service', 'product')   then i.total_cents else 0 end as revenue_cents,
  case when i.kind = 'service'                 then i.total_cents else 0 end as service_cents,
  case when i.kind = 'product'                 then i.total_cents else 0 end as retail_cents,
  case when i.kind = 'tip'                     then i.total_cents else 0 end as tips_cents,
  case when i.kind = 'late_cancellation_fee'   then i.total_cents else 0 end as fees_cents,
  case when i.kind = 'gift_card'               then i.total_cents else 0 end as gift_cards_sold_cents,
  case when i.kind = 'discount'                then -i.total_cents else 0 end as discount_cents, -- positive on a sale, like the header
  -- The calendar, in the transaction's location's zone.
  l.timezone,
  (t.created_at at time zone l.timezone)::date                                                as local_day,
  (date_trunc('week', (t.created_at at time zone l.timezone) + interval '1 day')::date - 1)    as local_week,
  date_trunc('month', t.created_at at time zone l.timezone)::date                              as local_month
from transaction_items i
join transactions t on t.id = i.transaction_id
join locations l on l.id = t.location_id;
