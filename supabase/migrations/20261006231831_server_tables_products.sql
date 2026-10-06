-- ============================================================
-- Migration: server-side tables — products (search, filter, sort, page)
-- npx supabase migration new server_tables_products
-- ============================================================
-- The second page function (docs/design/server-tables-design.md, PR 2),
-- on the helpers PR 1 made (search_words, search_like_pattern) and in the
-- same shape as clients_page: SECURITY INVOKER, RLS applies, the first
-- statement checks products.view and raises 42501.
--
-- Search: name and SKU, words AND, fields OR, escaped — what the page's
-- placeholder has always promised ("Search name, SKU…"); the description
-- is no longer searched. Filters: active (active | inactive | all) and
-- stock (out = none left, low = 1 to LOW_STOCK_THRESHOLD). Sorts:
-- name | price | stock | margin.
--
-- The low-stock threshold is ONE definition, shared/products/stock.ts
-- (LOW_STOCK_THRESHOLD = 5): the page's amber badge reads it, and
-- verify:tables imports it and asserts this function's boundary against
-- it — a product at the threshold is low, one above it is not, zero is
-- out and not low. This function cannot import TypeScript, so the
-- literal below is a COPY of that constant; change one without the other
-- and the harness fails.
--
-- Cost is for managers: cost_cents and margin_pct are in the row ONLY
-- when the caller holds products.manage, and the margin sort needs the
-- same (42501 otherwise) — a sort by cost would reveal its order to a
-- viewer who may not see the number. Everyone else gets the catalogue
-- fields and nothing about cost reaches the browser.
--
-- The two products policies evaluate their helpers once, as the clients
-- policies do since 20261006224905: products_read carries only USING;
-- products_manage (for all) carries only USING, which also serves as the
-- check for writes. Same predicates, same semantics.
--
-- Delete behaviour: adds indexes and a function; alters two policies.

-- ---
-- INDEXES
-- ---
create index products_name_trgm on products using gin (name extensions.gin_trgm_ops);
create index products_sku_trgm  on products using gin (sku  extensions.gin_trgm_ops);
-- The active filter and the default order within an organisation.
create index products_org_active_name on products (organization_id, active, lower(name));

-- ---
-- POLICIES: helpers evaluated once per statement
-- ---
alter policy products_read on products
  using (organization_id = (select current_org_id()) and (select has_permission('products.view')));
alter policy products_manage on products
  using (organization_id = (select current_org_id()) and (select has_permission('products.manage')));

-- ---
-- products_page
-- ---
create or replace function products_page(
  p_q         text    default null,
  p_active    text    default 'active',   -- active | inactive | all
  p_stock     text    default null,       -- out | low | null (any)
  p_sort      text    default 'name',     -- name | price | stock | margin
  p_desc      boolean default false,
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
  c_margin constant text := 'case when p.cost_cents is not null and p.price_cents > 0 then round((p.price_cents - p.cost_cents) * 100.0 / p.price_cents) end';
  c_sorts constant jsonb := jsonb_build_object(
    'name',   'lower(p.name)',
    'price',  'p.price_cents',
    'stock',  'p.stock_quantity',
    'margin', c_margin
  );
  -- A COPY of LOW_STOCK_THRESHOLD in shared/products/stock.ts (see the header).
  c_low_stock constant integer := 5;
  v_manage   boolean := has_permission('products.manage');
  v_words    text[] := search_words(p_q);
  v_patterns text[] := '{}';   -- $1: one escaped %word% per word
  v_where    text := ' where p.organization_id = current_org_id()';
  v_size     integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_page     integer := greatest(coalesce(p_page, 1), 1);
  v_total    bigint;
  v_rows     jsonb;
begin
  -- The signal. RLS is the backstop and would return nothing; this says why.
  if not has_permission('products.view') then
    raise exception 'products.view required' using errcode = 'insufficient_privilege';
  end if;
  if not c_sorts ? coalesce(p_sort, '') then
    raise exception 'Unknown sort: %', p_sort using errcode = 'invalid_parameter_value';
  end if;
  if p_sort = 'margin' and not v_manage then
    raise exception 'products.manage required to sort by margin' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_active, '') not in ('active', 'inactive', 'all') then
    raise exception 'Unknown active filter: %', p_active using errcode = 'invalid_parameter_value';
  end if;
  if p_stock is not null and p_stock not in ('out', 'low') then
    raise exception 'Unknown stock filter: %', p_stock using errcode = 'invalid_parameter_value';
  end if;

  -- Each word matches the name or the SKU. AND across words, OR across
  -- fields. The text only ever reaches the query as a bound parameter.
  for i in 1 .. coalesce(array_length(v_words, 1), 0) loop
    v_patterns := v_patterns || search_like_pattern(v_words[i]);
    v_where := v_where || format(' and (p.name ilike $1[%1$s] or p.sku ilike $1[%1$s])', i);
  end loop;
  if p_active = 'active' then v_where := v_where || ' and p.active'; end if;
  if p_active = 'inactive' then v_where := v_where || ' and not p.active'; end if;
  if p_stock = 'out' then v_where := v_where || ' and p.stock_quantity = 0'; end if;
  if p_stock = 'low' then v_where := v_where || format(' and p.stock_quantity between 1 and %s', c_low_stock); end if;

  -- Matches found once for the total and the page; ids and sort keys
  -- sorted and cut; JSON built for the page's rows only, with the cost
  -- fields appended for a manager and absent otherwise.
  execute format($q$
    with matched as materialized (
      select p.id, %2$s as s from products p %1$s
    ), page as (
      select x.id, row_number() over (order by x.s %3$s nulls last, x.id %3$s) as n
      from (select id, s from matched order by s %3$s nulls last, id %3$s limit %4$s offset %5$s) x
    )
    select (select count(*) from matched),
           (select coalesce(jsonb_agg((jsonb_build_object(
              'id', p.id, 'name', p.name, 'description', p.description, 'sku', p.sku,
              'price_cents', p.price_cents, 'stock_quantity', p.stock_quantity,
              'taxable', p.taxable, 'active', p.active
            ) || case when %6$L::boolean then jsonb_build_object('cost_cents', p.cost_cents, 'margin_pct', %7$s) else '{}'::jsonb end
            ) order by page.n), '[]'::jsonb)
            from products p join page on page.id = p.id)
  $q$, v_where, c_sorts ->> p_sort, case when p_desc then 'desc' else 'asc' end, v_size, (v_page - 1) * v_size, v_manage, c_margin)
    into v_total, v_rows using v_patterns;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_exact', true);
end;
$$;

comment on function products_page(text, text, text, text, boolean, integer, integer) is
  'One page of the caller''s organisation''s products, searched (name, SKU), filtered (active, stock out|low), sorted and paged in Postgres: {rows, total, total_exact}. SECURITY INVOKER: RLS applies; 42501 without products.view; cost_cents and margin_pct only for products.manage, which the margin sort also needs; 22023 on an unknown sort or filter.';

revoke execute on function products_page(text, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function products_page(text, text, text, text, boolean, integer, integer) to authenticated, service_role;
