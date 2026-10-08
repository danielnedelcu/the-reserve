-- ============================================================
-- Migration: ledger integrity — invariants at commit, append-only
-- for every role (PR 2 of docs/design/ledger-integrity-design.md)
-- npx supabase migration new ledger_integrity
-- ============================================================
-- The ledger's rules, enforced by the database rather than trusted to
-- the routes: at commit, every transaction balances (payments to the
-- total, lines to the header) and every refund mirrors its original;
-- no row is ever updated or deleted, by any role; TRUNCATE is gone from
-- the service role; every foreign key out of the ledger refuses the
-- parent's deletion. Error codes:
--   LD010  an invariant failed at commit (the message names the rule)
--   LD003  an update or delete on a ledger row

-- ------------------------------------------------------------
-- 1. INVARIANTS, CHECKED AT COMMIT
-- ------------------------------------------------------------
-- One function checks the whole transaction; a deferred constraint
-- trigger on each of the three tables calls it for the transaction a
-- new row belongs to. Deferred to commit, so write_ledger_transaction
-- (and a fixture inside one transaction) may insert in any order.

create or replace function assert_ledger_transaction(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t             transactions%rowtype;
  o             transactions%rowtype;
  v_lines       int;
  v_sale        bigint;
  v_discount    bigint;
  v_tip         bigint;
  v_tax         bigint;
  v_lines_sum   bigint;
  v_paid        bigint;
  v_payments    int;
  v_o_lines     int;
  v_o_lines_sum bigint;
  v_o_payments  int;
  v_o_paid      bigint;
begin
  select * into t from transactions where id = p_transaction_id;
  if not found then
    return; -- the row was rolled back with the statement that made it
  end if;

  select count(*),
         coalesce(sum(total_cents) filter (where kind in ('service','product','gift_card','late_cancellation_fee')), 0),
         coalesce(sum(total_cents) filter (where kind = 'discount'), 0),
         coalesce(sum(total_cents) filter (where kind = 'tip'), 0),
         coalesce(sum(tax_cents), 0),
         coalesce(sum(total_cents), 0)
    into v_lines, v_sale, v_discount, v_tip, v_tax, v_lines_sum
    from transaction_items where transaction_id = t.id;
  select count(*), coalesce(sum(amount_cents), 0)
    into v_payments, v_paid
    from payments where transaction_id = t.id;

  if v_lines = 0 then
    raise exception 'ledger.lines: transaction % has no lines', t.id using errcode = 'LD010';
  end if;
  if v_sale <> t.subtotal_cents then
    raise exception 'ledger.subtotal: transaction % lines sum to % but subtotal_cents is %', t.id, v_sale, t.subtotal_cents using errcode = 'LD010';
  end if;
  if v_discount <> -t.discount_cents then
    raise exception 'ledger.discount: transaction % discount lines sum to % but discount_cents is %', t.id, v_discount, t.discount_cents using errcode = 'LD010';
  end if;
  if v_tip <> t.tip_cents then
    raise exception 'ledger.tip: transaction % tip lines sum to % but tip_cents is %', t.id, v_tip, t.tip_cents using errcode = 'LD010';
  end if;
  if v_tax <> t.tax_cents then
    raise exception 'ledger.tax: transaction % line tax sums to % but tax_cents is %', t.id, v_tax, t.tax_cents using errcode = 'LD010';
  end if;
  if t.total_cents = 0 and v_payments > 0 then
    raise exception 'ledger.zero_total: transaction % has a zero total and % payment row(s)', t.id, v_payments using errcode = 'LD010';
  end if;
  if v_paid <> t.total_cents then
    raise exception 'ledger.payments: transaction % payments sum to % but total_cents is %', t.id, v_paid, t.total_cents using errcode = 'LD010';
  end if;

  if t.refunds_transaction_id is not null then
    select * into o from transactions where id = t.refunds_transaction_id;
    if o.refunds_transaction_id is not null then
      raise exception 'ledger.refund_of_refund: transaction % refunds %, which is itself a refund', t.id, o.id using errcode = 'LD010';
    end if;
    if t.subtotal_cents <> -o.subtotal_cents or t.discount_cents <> -o.discount_cents
       or t.tax_cents <> -o.tax_cents or t.tip_cents <> -o.tip_cents or t.total_cents <> -o.total_cents
       or t.client_id is distinct from o.client_id or t.appointment_id is distinct from o.appointment_id
       or t.location_id is distinct from o.location_id then
      raise exception 'ledger.refund_header: refund % does not mirror original % (money negated; client, appointment and location equal)', t.id, o.id using errcode = 'LD010';
    end if;
    select count(*), coalesce(sum(total_cents), 0) into v_o_lines, v_o_lines_sum from transaction_items where transaction_id = o.id;
    if v_lines <> v_o_lines or v_lines_sum <> -v_o_lines_sum then
      raise exception 'ledger.refund_lines: refund % has % line(s) summing to %; original % has % summing to %', t.id, v_lines, v_lines_sum, o.id, v_o_lines, v_o_lines_sum using errcode = 'LD010';
    end if;
    select count(*), coalesce(sum(amount_cents), 0) into v_o_payments, v_o_paid from payments where transaction_id = o.id;
    if v_payments <> v_o_payments or v_paid <> -v_o_paid then
      raise exception 'ledger.refund_payments: refund % has % payment(s) summing to %; original % has % summing to %', t.id, v_payments, v_paid, o.id, v_o_payments, v_o_paid using errcode = 'LD010';
    end if;
  end if;
end $$;

comment on function assert_ledger_transaction(uuid) is
  'The ledger''s invariants, checked at COMMIT by deferred constraint triggers on transactions, transaction_items and payments: at least one line; sale-kind lines = subtotal, discount lines = -discount, tip lines = tip, line tax = tax; payments = total, and a zero total has no payment rows; a refund mirrors its original exactly (money negated, client/appointment/location equal, line and payment sums and counts negated) and never refunds a refund. THE MIRROR FORBIDS PARTIAL REFUNDS: relax ledger.refund_lines / ledger.refund_payments deliberately when they are built (docs/design/ledger-integrity-design.md). Security definer (it reads every organisation''s ledger): execute is revoked from the API roles; only the triggers call it.';

create or replace function trg_assert_ledger_transaction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'transactions' then
    perform assert_ledger_transaction(new.id);
  else
    perform assert_ledger_transaction(new.transaction_id);
  end if;
  return null;
end $$;

-- Security definer functions that read across organisations: no API
-- role may call them directly (default privileges would have granted
-- EXECUTE to anon and authenticated, and Postgres grants it to PUBLIC).
revoke execute on function assert_ledger_transaction(uuid) from public, anon, authenticated;
revoke execute on function trg_assert_ledger_transaction() from public, anon, authenticated;

create constraint trigger trg_ledger_transactions_balanced
  after insert on transactions
  deferrable initially deferred
  for each row execute function trg_assert_ledger_transaction();
create constraint trigger trg_ledger_items_balanced
  after insert on transaction_items
  deferrable initially deferred
  for each row execute function trg_assert_ledger_transaction();
create constraint trigger trg_ledger_payments_balanced
  after insert on payments
  deferrable initially deferred
  for each row execute function trg_assert_ledger_transaction();

-- ------------------------------------------------------------
-- 2. ONE REFUND PER ORIGINAL — structural, not by key naming
-- ------------------------------------------------------------
create unique index transactions_one_refund_per_original
  on transactions (refunds_transaction_id)
  where refunds_transaction_id is not null;

-- ------------------------------------------------------------
-- 3. LINE ARITHMETIC — immediate
-- ------------------------------------------------------------
alter table transaction_items
  add constraint transaction_items_total_is_qty_times_unit
  check (total_cents = quantity * unit_price_cents);

-- ------------------------------------------------------------
-- 4. APPEND-ONLY, FOR EVERY ROLE
-- ------------------------------------------------------------
-- An ordinary (ORIGIN) trigger, so it binds the service role and the
-- API roles alike; the only way past it is session_replication_role =
-- replica on a direct postgres connection, which the API never has.
-- Local test and seed cleanup use exactly that, behind a localhost guard.
create or replace function ledger_block_change()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger rows are corrected by a refund, never edited: % on % refused', tg_op, tg_table_name
    using errcode = 'LD003';
end $$;

create trigger trg_transactions_append_only
  before update or delete on transactions
  for each row execute function ledger_block_change();
create trigger trg_transaction_items_append_only
  before update or delete on transaction_items
  for each row execute function ledger_block_change();
create trigger trg_payments_append_only
  before update or delete on payments
  for each row execute function ledger_block_change();

-- TRUNCATE fires no row trigger; the privilege is what covers it. The
-- API roles lost it in explicit_api_grants; the service role loses it
-- here. (A later "grant all on all tables to service_role" would hand
-- it back — grant per table instead.)
revoke truncate on transactions, transaction_items, payments from service_role;

comment on table transactions is
  'The immutable money ledger: one row per checkout. Append-only for EVERY role, the service role included (trg_transactions_append_only); corrections are refunds — new rows with negative amounts referencing the original via refunds_transaction_id, one per original. Balanced at commit by assert_ledger_transaction. All financial reporting reads from here.';

-- ------------------------------------------------------------
-- 5. FOREIGN KEYS: RESTRICT, STATED
-- ------------------------------------------------------------
-- All eleven were "no action" — the same refusal, by default and at
-- statement end. Restrict says it: anything a ledger row points at is
-- deactivated, never deleted.
alter table transactions
  drop constraint transactions_organization_id_fkey,
  add constraint transactions_organization_id_fkey foreign key (organization_id) references organizations(id) on delete restrict,
  drop constraint transactions_location_id_fkey,
  add constraint transactions_location_id_fkey foreign key (location_id) references locations(id) on delete restrict,
  drop constraint transactions_client_id_fkey,
  add constraint transactions_client_id_fkey foreign key (client_id) references clients(id) on delete restrict,
  drop constraint transactions_appointment_id_fkey,
  add constraint transactions_appointment_id_fkey foreign key (appointment_id) references appointments(id) on delete restrict,
  drop constraint transactions_checked_out_by_fkey,
  add constraint transactions_checked_out_by_fkey foreign key (checked_out_by) references staff(id) on delete restrict,
  drop constraint transactions_refunds_transaction_id_fkey,
  add constraint transactions_refunds_transaction_id_fkey foreign key (refunds_transaction_id) references transactions(id) on delete restrict;

alter table transaction_items
  drop constraint transaction_items_appointment_id_fkey,
  add constraint transaction_items_appointment_id_fkey foreign key (appointment_id) references appointments(id) on delete restrict,
  drop constraint transaction_items_product_id_fkey,
  add constraint transaction_items_product_id_fkey foreign key (product_id) references products(id) on delete restrict,
  drop constraint transaction_items_gift_card_id_fkey,
  add constraint transaction_items_gift_card_id_fkey foreign key (gift_card_id) references gift_cards(id) on delete restrict,
  drop constraint transaction_items_staff_id_fkey,
  add constraint transaction_items_staff_id_fkey foreign key (staff_id) references staff(id) on delete restrict;

alter table payments
  drop constraint payments_gift_card_id_fkey,
  add constraint payments_gift_card_id_fkey foreign key (gift_card_id) references gift_cards(id) on delete restrict;
