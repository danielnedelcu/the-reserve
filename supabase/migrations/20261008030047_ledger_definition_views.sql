-- ============================================================
-- Migration: the one revenue definition as views — ledger_lines,
-- ledger_transactions — and transactions_page reading it
-- npx supabase migration new ledger_definition_views
-- ============================================================
-- The kind-to-category mapping (which lines are revenue, tips, fees,
-- gift-card sales, discounts) and the location-local calendar used to
-- live in transactions_page's totals and, separately and differently,
-- in Ask's presets and prompt (docs/design/server-tables-design.md
-- decision 2; the Ask board item). Now they live ONCE, in two
-- security-invoker views; transactions_page sums the view's category
-- columns, Ask's presets select from it, and the model is told to.
--
-- Zone: each transaction's OWN location, joined under the caller's RLS.
-- locations_read lets every member of the organisation read its
-- locations with no permission key and no active filter, so the join
-- cannot drop a ledger row the caller may read, and a deactivated
-- location's past revenue stays in every report. transactions.location_id
-- has been NOT NULL since the ledger migration (0 nulls on hosted,
-- checked 2026-10-08), so no transaction can fall out of the join.
--
-- Weeks start on Sunday (shared/time/period.ts): Postgres weeks start
-- Monday, so the day is shifted forward before truncating and back after.

-- ------------------------------------------------------------
-- 1. LEDGER_LINES — one row per transaction line, categorised, dated
-- ------------------------------------------------------------
create or replace view ledger_lines
with (security_invoker = true)
as
select
  i.id,
  i.transaction_id,
  t.organization_id,
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

comment on view ledger_lines is
  'THE revenue definition, one row per transaction line (docs/design/server-tables-design.md decision 2; docs/design/ask-the-reserve-design.md). revenue_cents = service + product lines, pre-tax, gross of discounts, net of refunds (mirror lines are negative; never filter by sign). tips_cents, fees_cents (late cancellation), gift_cards_sold_cents (a liability, never revenue) and discount_cents are their own figures; tax is tax_cents per line. local_day / local_week (Sunday start) / local_month are the transaction''s own location''s calendar. SECURITY INVOKER: the ledger''s RLS applies as the caller. transactions_page, the dashboard and Ask all sum these columns; nothing classifies kinds elsewhere.';

-- ------------------------------------------------------------
-- 2. LEDGER_TRANSACTIONS — one row per transaction, dated
-- ------------------------------------------------------------
create or replace view ledger_transactions
with (security_invoker = true)
as
select
  t.id,
  t.organization_id,
  t.location_id,
  t.client_id,
  t.appointment_id,
  t.checked_out_by,
  t.refunds_transaction_id,
  (t.refunds_transaction_id is not null)                                   as is_refund,
  t.subtotal_cents,
  t.discount_cents,
  t.tax_cents,
  t.tip_cents,
  t.total_cents,
  t.note,
  t.created_at,
  l.timezone,
  (t.created_at at time zone l.timezone)::date                                                as local_day,
  (date_trunc('week', (t.created_at at time zone l.timezone) + interval '1 day')::date - 1)    as local_week,
  date_trunc('month', t.created_at at time zone l.timezone)::date                              as local_month
from transactions t
join locations l on l.id = t.location_id;

comment on view ledger_transactions is
  'One row per transaction with the header figures (discount_cents and tax_cents are kept on the header; a refund''s are negative) and the transaction''s own location''s calendar: local_day / local_week (Sunday start) / local_month. Counts and averages come from here (non-refund rows); line categories from ledger_lines. SECURITY INVOKER: the ledger''s RLS applies as the caller.';

-- Security invoker is explicit above: a default view runs as its owner
-- (postgres) and would bypass RLS. The grants are the second half.
revoke select on ledger_lines, ledger_transactions from public, anon;
grant  select on ledger_lines, ledger_transactions to authenticated, ask_readonly;

-- ------------------------------------------------------------
-- 3. TRANSACTIONS_PAGE — totals and by_staff from the view
-- ------------------------------------------------------------
-- The server_tables_transactions body with three changes: `items` reads
-- ledger_lines; the totals sum its category columns; by_staff sums
-- service_cents / tips_cents from it. Same signature, so create or
-- replace keeps the grants (authenticated, service_role; revoked from
-- public and anon). Everything else — search, filters, page, row JSON —
-- is unchanged (the diff was reviewed line by line, 2026-10-08).
create or replace function transactions_page(
  p_from      timestamptz,
  p_to        timestamptz,
  p_q         text    default null,
  p_kind      text    default null,       -- sale | refund | fee | null (any)
  p_method    text    default null,       -- card_external | gift_card | cash | stripe_card | null
  p_staff_id  uuid    default null,       -- the cashier, or a provider attributed on a line
  p_sort      text    default 'when',     -- when | client | total
  p_desc      boolean default true,
  p_page      integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  c_sorts constant jsonb := jsonb_build_object(
    'when',   't.created_at',
    'client', 'lower(coalesce(c.last_name || '', '' || c.first_name, ''walk-in''))',
    'total',  't.total_cents'
  );
  -- kind = 'fee': an original late-cancellation fee charge (not a refund's mirror of one).
  c_fee constant text := 't.refunds_transaction_id is null and exists (select 1 from transaction_items f where f.transaction_id = t.id and f.kind = ''late_cancellation_fee'')';
  v_words    text[] := search_words(p_q);
  v_patterns text[] := '{}';      -- $1: one escaped %word% per word
  v_walkin   boolean[] := '{}';   -- $2: does the word match "walk-in"?
  v_cents    bigint;
  v_where    text := ' where t.organization_id = current_org_id() and t.created_at >= $3 and t.created_at < $4';
  v_size     integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_page     integer := greatest(coalesce(p_page, 1), 1);
  v_total    bigint;
  v_totals   jsonb;
  v_by_staff jsonb;
  v_rows     jsonb;
begin
  -- The signal. RLS is the backstop and would return nothing; this says why.
  if not has_permission('transactions.view') then
    raise exception 'transactions.view required' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A range is required: p_from before p_to' using errcode = 'invalid_parameter_value';
  end if;
  if not c_sorts ? coalesce(p_sort, '') then
    raise exception 'Unknown sort: %', p_sort using errcode = 'invalid_parameter_value';
  end if;
  if p_kind is not null and p_kind not in ('sale', 'refund', 'fee') then
    raise exception 'Unknown kind: %', p_kind using errcode = 'invalid_parameter_value';
  end if;
  if p_method is not null and p_method not in ('card_external', 'gift_card', 'cash', 'stripe_card') then
    raise exception 'Unknown method: %', p_method using errcode = 'invalid_parameter_value';
  end if;

  -- Each word matches the client's name (or "walk-in" for a row with no
  -- client), an item name, a payment reference, the note, or — when it
  -- looks like 45 or $45.00 — the amount, sale or refund. One id lookup
  -- per field, UNIONed, so each uses its own index. AND across words.
  for i in 1 .. coalesce(array_length(v_words, 1), 0) loop
    v_patterns := v_patterns || search_like_pattern(v_words[i]);
    v_walkin := v_walkin || ('walk-in' ilike search_like_pattern(v_words[i]));
    -- Money only when it reads as money: up to seven digits, an optional
    -- one- or two-digit decimal. Longer digit runs are references.
    v_cents := null;
    if v_words[i] ~ '^\$?[0-9]{1,7}(\.[0-9]{1,2})?$' then
      v_cents := round(ltrim(v_words[i], '$')::numeric * 100)::bigint;
    end if;
    v_where := v_where || format('
      and t.id in (
        select x.id from transactions x join clients y on y.id = x.client_id
          where y.first_name ilike $1[%1$s] or y.last_name ilike $1[%1$s]
        union select x.id from transactions x where x.client_id is null and $2[%1$s]
        union select x.transaction_id from transaction_items x where x.name_snapshot ilike $1[%1$s]
        union select x.transaction_id from payments x where x.reference ilike $1[%1$s]
        union select x.id from transactions x where x.note ilike $1[%1$s]%2$s)',
      i, case when v_cents is not null then format(' union select x.id from transactions x where abs(x.total_cents) = %s', v_cents) else '' end);
  end loop;
  if p_kind = 'refund' then v_where := v_where || ' and t.refunds_transaction_id is not null'; end if;
  if p_kind = 'fee'    then v_where := v_where || ' and ' || c_fee; end if;
  if p_kind = 'sale'   then v_where := v_where || ' and t.refunds_transaction_id is null and not (' || c_fee || ')'; end if;
  if p_method is not null then
    v_where := v_where || ' and exists (select 1 from payments p where p.transaction_id = t.id and p.method = $5)';
  end if;
  if p_staff_id is not null then
    v_where := v_where || ' and (t.checked_out_by = $6 or exists (select 1 from transaction_items i where i.transaction_id = t.id and i.staff_id = $6))';
  end if;

  -- The matches are found once. The totals and by_staff are over ALL of
  -- them — the same set the count reports and the page is cut from — so
  -- the cards and the rows cannot disagree. JSON is built for the page only.
  -- The categories (what is revenue, a tip, a fee, a gift-card sale) are
  -- ledger_lines' columns, THE definition; nothing here names a kind.
  execute format($q$
    with matched as materialized (
      select t.id, %2$s as s from transactions t left join clients c on c.id = t.client_id %1$s
    ),
    hdr as (select t.* from transactions t join matched m on m.id = t.id),
    items as (select l.* from ledger_lines l join matched m on m.id = l.transaction_id),
    page as (
      select x.id, row_number() over (order by x.s %3$s nulls last, x.id %3$s) as n
      from (select id, s from matched order by s %3$s nulls last, id %3$s limit %4$s offset %5$s) x
    )
    select
      (select count(*) from matched),
      jsonb_build_object(
        'service_cents',         (select coalesce(sum(service_cents), 0) from items),
        'retail_cents',          (select coalesce(sum(retail_cents), 0) from items),
        'revenue_cents',         (select coalesce(sum(revenue_cents), 0) from items),
        'tips_cents',            (select coalesce(sum(tips_cents), 0) from items),
        'discounts_cents',       (select coalesce(sum(discount_cents), 0) from hdr),
        'tax_cents',             (select coalesce(sum(tax_cents), 0) from hdr),
        'gift_cards_sold_cents', (select coalesce(sum(gift_cards_sold_cents), 0) from items),
        'fees_cents',            (select coalesce(sum(fees_cents), 0) from items),
        'refunds_cents',         (select coalesce(sum(-total_cents), 0) from hdr where refunds_transaction_id is not null),
        'txn_count',             (select count(*) from hdr where refunds_transaction_id is null),
        'avg_ticket_cents',      (select case when count(*) = 0 then 0 else round(sum(total_cents)::numeric / count(*)) end
                                    from hdr where refunds_transaction_id is null)
      ),
      -- Every staff_id with a service or tip line in the matches: the
      -- money is the line's and is always here; the name is the staff
      -- row's and is null when the caller cannot read it (or the row is
      -- gone). Active or not: attribution is the line's, not the roster's.
      (select coalesce(jsonb_agg(jsonb_build_object(
          'staff_id', x.staff_id, 'display_name', s.display_name, 'active', s.active,
          'service_cents', x.service_cents, 'tips_cents', x.tips_cents
        ) order by x.service_cents desc, s.display_name nulls last), '[]'::jsonb)
        from (select staff_id,
                     coalesce(sum(service_cents), 0) as service_cents,
                     coalesce(sum(tips_cents), 0)    as tips_cents
                from items where staff_id is not null group by staff_id) x
        left join staff s on s.id = x.staff_id),
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', t.id, 'created_at', t.created_at,
          'subtotal_cents', t.subtotal_cents, 'discount_cents', t.discount_cents, 'tax_cents', t.tax_cents,
          'tip_cents', t.tip_cents, 'total_cents', t.total_cents,
          'refunds_transaction_id', t.refunds_transaction_id,
          'refunded', exists (select 1 from transactions r where r.refunds_transaction_id = t.id),
          'note', t.note,
          'has_client', t.client_id is not null,
          'client', case when c.id is null then null else jsonb_build_object('first_name', c.first_name, 'last_name', c.last_name) end,
          'cashier_id', t.checked_out_by,
          'cashier', (select s.display_name from staff s where s.id = t.checked_out_by),
          'items', (select coalesce(jsonb_agg(jsonb_build_object(
                      'kind', i.kind, 'name_snapshot', i.name_snapshot, 'quantity', i.quantity,
                      'total_cents', i.total_cents, 'tax_cents', i.tax_cents, 'staff_id', i.staff_id) order by i.id), '[]'::jsonb)
                    from transaction_items i where i.transaction_id = t.id),
          'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                      'method', p.method, 'amount_cents', p.amount_cents, 'reference', p.reference) order by p.created_at), '[]'::jsonb)
                    from payments p where p.transaction_id = t.id)
        ) order by page.n), '[]'::jsonb)
        from transactions t left join clients c on c.id = t.client_id join page on page.id = t.id)
  $q$, v_where, c_sorts ->> p_sort, case when p_desc then 'desc' else 'asc' end, v_size, (v_page - 1) * v_size)
    into v_total, v_totals, v_by_staff, v_rows
    using v_patterns, v_walkin, p_from, p_to, p_method, p_staff_id;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_exact', true, 'totals', v_totals, 'by_staff', v_by_staff);
end;
$$;

comment on function transactions_page(timestamptz, timestamptz, text, text, text, uuid, text, boolean, integer, integer) is
  'One page of the caller''s organisation''s transactions in [p_from, p_to), searched (client name or walk-in, item names, payment references, note, exact amount), filtered (kind sale|refund|fee — fee is an original late-cancellation charge, its refund is a refund —, method, staff), sorted and paged in Postgres — plus totals and by_staff over EVERY match, summing ledger_lines'' category columns — THE revenue definition (service + product, pre-tax, gross of discounts, net of refunds; tips, gift cards, fees and tax separate), stated once in that view. SECURITY INVOKER; 42501 without transactions.view; 22023 on a missing range or an unknown sort or filter. Joins degrade visibly: has_client with client null means a client the caller may not read; by_staff keeps every line''s money under staff_id with the name null when the staff row is unreadable. The cards call it with p_page_size => 1.';

