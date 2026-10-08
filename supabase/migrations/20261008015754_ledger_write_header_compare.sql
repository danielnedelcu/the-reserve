-- ============================================================
-- Migration: ledger write — the retry comparison covers the header
-- npx supabase migration new ledger_write_header_compare
-- ============================================================
-- Repairs write_ledger_transaction (ledger_atomic_write, applied to
-- hosted 2026-10-08 minutes before this ruling landed): a reused key
-- now has to match the stored transaction on the header's money fields
-- and on client, appointment and the refunded original — not only on
-- the total, the lines and the payments. checked_out_by, location_id
-- and note stay out of the comparison on purpose: a colleague retrying
-- the same cart is the same sale. Function replaced whole, in the
-- pos_refund_fix shape; grants unchanged.

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
    transaction_id, kind, appointment_id, product_id, gift_card_id, staff_id,
    name_snapshot, quantity, unit_price_cents, taxable, tax_cents, total_cents, discount_reason
  )
  select
    v_id, i.kind, i.appointment_id, i.product_id, i.gift_card_id, i.staff_id,
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
    transaction_id, method, amount_cents, gift_card_id, reference, stripe_payment_intent_id
  )
  select v_id, p.method, p.amount_cents, p.gift_card_id, p.reference, p.stripe_payment_intent_id
  from jsonb_to_recordset(p_payments) as p(
    method text, amount_cents int, gift_card_id uuid, reference text, stripe_payment_intent_id text
  );

  return v_id;
end $$;

comment on function write_ledger_transaction(uuid, text, jsonb, jsonb, jsonb) is
  'The ONE way ledger rows are written: header, lines and payments in one transaction, keyed by (organisation, idempotency_key). A reused key returns the existing id and writes nothing (a retry) when the request matches what the key wrote on: total, subtotal, discount, tax, tip, client, appointment, the refunded original, the lines (kind, what, quantity, price) and the payments (tender, amount); checked_out_by, location and note are not compared, so a colleague retrying the same cart is the same sale. A reused key with a different request raises LD001 (the route answers 409 and the page must mint a new key only after showing the first sale went through). Unknown JSON keys raise 22023 rather than becoming silent nulls. Any referenced row from another organisation raises LD002. Pricing and Stripe stay in the routes, which call this once after the money has moved. Service role only.';

