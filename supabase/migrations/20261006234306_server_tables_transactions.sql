-- ============================================================
-- Migration: server-side tables — transactions (search, filter, sort, page, totals)
-- npx supabase migration new server_tables_transactions
-- ============================================================
-- The third page function (docs/design/server-tables-design.md, PR 3,
-- decisions 2 and 3). transactions_page answers the /financials page's
-- question for ONE range: a page of transactions, searched, filtered,
-- sorted and paged in Postgres, plus the money TOTALS and the per-staff
-- attribution over every match — so the cards above the table can never
-- disagree with the rows beneath, and the figures stop being sums over
-- a browser array cut at max_rows.
--
-- The range is two instants, p_from inclusive and p_to exclusive, that the
-- page derives ONCE from the URL in the location's zone
-- (shared/time/period.ts). This function never re-derives the period: it
-- filters created_at on transactions_org_day and nothing else.
--
-- Revenue, written down (decision 2, what the cards have always shown):
-- service + product item totals, pre-tax, GROSS of discounts, NET of
-- refunds through the mirror rows. Tips, gift-card sales (a liability),
-- late-cancellation fees (their own figure) and tax are never in it.
-- Nothing is filtered by sign: a refund is a transaction with negative
-- amounts, counted in the period it was ISSUED. Two owner confirmations
-- on the board can each change one line here.
--
-- Access: SECURITY INVOKER, transactions.view checked first (42501).
-- Search: the client's name (and "walk-in" for rows with no client), item
-- names, payment references, the note, and an exact amount when a word
-- looks like 45 or $45.00 — at most seven digits before an optional one-
-- or two-digit decimal, so a card reference or a phone number is never
-- cast as money (it is still searched as text against references and
-- notes). Each row returns only what the table shows.
--
-- Joins degrade visibly (the invoker rule, decision 1): a caller without
-- clients.view gets client null with has_client true, which the page
-- shows as "Client hidden", never "Walk-in"; by_staff is a LEFT join
-- that keeps every line's money under its staff_id even when the staff
-- row is unreadable, with display_name null; cashier is null the same way.
--
-- kind = 'fee' is an ORIGINAL late-cancellation fee charge only; a
-- refunded fee's mirror row is a refund and sits under kind = 'refund'.
--
-- The three ledger read policies evaluate their helpers once per
-- statement (the clients and products policies do since 20261006224905
-- and 20261006231831). transaction_items_read and payments_read called
-- has_permission() INSIDE a per-row exists; the exists stays — it is the
-- org scope through the parent row, one primary-key lookup — and the two
-- helper calls move out of it as scalar subqueries. gift_cards_read the
-- same, since gift_card_liability() sums that table.
--
-- Delete behaviour: adds indexes and two functions; alters four policies.

-- ---
-- INDEXES
-- ---
create index transaction_items_name_trgm on transaction_items using gin (name_snapshot extensions.gin_trgm_ops);
create index payments_reference_trgm    on payments          using gin (reference     extensions.gin_trgm_ops);
create index transactions_note_trgm     on transactions      using gin (note          extensions.gin_trgm_ops);
-- "Has this transaction been refunded?" — the refund's pointer back.
create index transactions_refund_of on transactions (refunds_transaction_id) where refunds_transaction_id is not null;

-- ---
-- POLICIES: helpers evaluated once per statement
-- ---
alter policy transactions_read on transactions
  using (organization_id = (select current_org_id()) and (select has_permission('transactions.view')));
alter policy transaction_items_read on transaction_items
  using (exists (select 1 from transactions t where t.id = transaction_items.transaction_id and t.organization_id = (select current_org_id()))
         and (select has_permission('transactions.view')));
alter policy payments_read on payments
  using (exists (select 1 from transactions t where t.id = payments.transaction_id and t.organization_id = (select current_org_id()))
         and (select has_permission('transactions.view')));
alter policy gift_cards_read on gift_cards
  using (organization_id = (select current_org_id()) and (select has_permission('gift_cards.view')));

-- ---
-- gift_card_liability: what the club owes on cards, summed in Postgres
-- ---
create or replace function gift_card_liability()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_cards bigint;
  v_cents bigint;
begin
  if not has_permission('gift_cards.view') then
    raise exception 'gift_cards.view required' using errcode = 'insufficient_privilege';
  end if;
  select count(*), coalesce(sum(balance_cents), 0) into v_cards, v_cents
    from gift_cards where organization_id = current_org_id() and active;
  return jsonb_build_object('active_cards', v_cards, 'liability_cents', v_cents);
end;
$$;
comment on function gift_card_liability() is
  'The sum of every ACTIVE gift card''s balance in the caller''s organisation — the liability the cards represent — and how many there are. SECURITY INVOKER; 42501 without gift_cards.view. All-time, not period-scoped: a balance is owed until it is redeemed.';
revoke execute on function gift_card_liability() from public, anon;
grant execute on function gift_card_liability() to authenticated, service_role;

-- ---
-- transactions_page
-- ---
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
  execute format($q$
    with matched as materialized (
      select t.id, %2$s as s from transactions t left join clients c on c.id = t.client_id %1$s
    ),
    hdr as (select t.* from transactions t join matched m on m.id = t.id),
    items as (select i.* from transaction_items i join matched m on m.id = i.transaction_id),
    page as (
      select x.id, row_number() over (order by x.s %3$s nulls last, x.id %3$s) as n
      from (select id, s from matched order by s %3$s nulls last, id %3$s limit %4$s offset %5$s) x
    )
    select
      (select count(*) from matched),
      jsonb_build_object(
        'service_cents',         (select coalesce(sum(total_cents), 0) from items where kind = 'service'),
        'retail_cents',          (select coalesce(sum(total_cents), 0) from items where kind = 'product'),
        'revenue_cents',         (select coalesce(sum(total_cents), 0) from items where kind in ('service', 'product')),
        'tips_cents',            (select coalesce(sum(total_cents), 0) from items where kind = 'tip'),
        'discounts_cents',       (select coalesce(sum(discount_cents), 0) from hdr),
        'tax_cents',             (select coalesce(sum(tax_cents), 0) from hdr),
        'gift_cards_sold_cents', (select coalesce(sum(total_cents), 0) from items where kind = 'gift_card'),
        'fees_cents',            (select coalesce(sum(total_cents), 0) from items where kind = 'late_cancellation_fee'),
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
                     coalesce(sum(total_cents) filter (where kind = 'service'), 0) as service_cents,
                     coalesce(sum(total_cents) filter (where kind = 'tip'), 0) as tips_cents
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
  'One page of the caller''s organisation''s transactions in [p_from, p_to), searched (client name or walk-in, item names, payment references, note, exact amount), filtered (kind sale|refund|fee — fee is an original late-cancellation charge, its refund is a refund —, method, staff), sorted and paged in Postgres — plus totals and by_staff over EVERY match (the one revenue definition: service + product, pre-tax, gross of discounts, net of refunds; tips, gift cards, fees and tax separate). SECURITY INVOKER; 42501 without transactions.view; 22023 on a missing range or an unknown sort or filter. Joins degrade visibly: has_client with client null means a client the caller may not read; by_staff keeps every line''s money under staff_id with the name null when the staff row is unreadable. The cards call it with p_page_size => 1.';

revoke execute on function transactions_page(timestamptz, timestamptz, text, text, text, uuid, text, boolean, integer, integer) from public, anon;
grant execute on function transactions_page(timestamptz, timestamptz, text, text, text, uuid, text, boolean, integer, integer) to authenticated, service_role;
