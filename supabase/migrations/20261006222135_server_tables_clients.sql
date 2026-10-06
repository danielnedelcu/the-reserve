-- ============================================================
-- Migration: server-side tables — clients (search, filter, sort, page)
-- npx supabase migration new server_tables_clients
-- ============================================================
-- The first of the three page functions (docs/design/server-tables-design.md,
-- PR 1). One function answers the /clients page's question — one page of
-- rows plus the total, searched, filtered, sorted and paged in Postgres —
-- so the page stops loading every row and being cut at max_rows without
-- an error.
--
-- Access: SECURITY INVOKER (decision 1). RLS and current_org_id() apply
-- to every row the function reads, exactly as they do to the page today.
-- The first statement checks clients.view and raises 42501, so a caller
-- without the permission gets an error, never an empty table that looks
-- like an empty organisation.
--
-- Search: the text is split into words (at most 8, each up to 100
-- characters); every word has to match the first name, last name, email
-- or phone. Words are escaped, so % and _ match themselves. A word with
-- three or more digits also matches the phone's digits, so "555 0100"
-- finds "(555) 010-0…". Trigram indexes (pg_trgm) keep the "contains"
-- searches fast. Nothing else on the row is searched: not notes, flags,
-- date of birth, address, emergency contact.
--
-- Returned: only what the list shows. Never date_of_birth, the address,
-- the emergency contact — the edit sheet reads the one row it opens.
--
-- Delete behaviour: adds an extension, indexes and functions only.

-- ---
-- EXTENSION AND INDEXES
-- ---
create extension if not exists pg_trgm with schema extensions;

-- "Search anything": contains-searches on these use the trigram indexes.
create index clients_first_name_trgm on clients using gin (first_name extensions.gin_trgm_ops);
create index clients_last_name_trgm  on clients using gin (last_name  extensions.gin_trgm_ops);
create index clients_email_trgm      on clients using gin (email      extensions.gin_trgm_ops);
create index clients_phone_digits_trgm on clients
  using gin ((regexp_replace(coalesce(phone, ''), '\D', '', 'g')) extensions.gin_trgm_ops);

-- The active filter and the default order within an organisation.
create index clients_org_active_name on clients (organization_id, active, lower(last_name), lower(first_name));

-- ---
-- SEARCH HELPERS (shared by every page function)
-- ---

-- The search text as words: lower-cased, trimmed, at most 8, each cut to
-- 100 characters. Empty text gives an empty array.
create or replace function search_words(p_q text)
returns text[]
language sql immutable set search_path = public
as $$
  select coalesce(array_agg(left(w, 100)), '{}')
  from (
    select w from unnest(regexp_split_to_array(lower(trim(coalesce(p_q, ''))), '\s+')) as w
    where w <> ''
    limit 8
  ) words
$$;

-- One word as a "contains" pattern for ILIKE: escaped, so \, % and _ in
-- what was typed match themselves.
create or replace function search_like_pattern(p_word text)
returns text
language sql immutable set search_path = public
as $$
  select '%' || replace(replace(replace(p_word, '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

revoke execute on function search_words(text) from public, anon;
revoke execute on function search_like_pattern(text) from public, anon;
grant execute on function search_words(text) to authenticated, service_role;
grant execute on function search_like_pattern(text) to authenticated, service_role;

-- ---
-- clients_page
-- ---
create or replace function clients_page(
  p_q         text    default null,
  p_active    text    default 'active',   -- active | inactive | all
  p_sort      text    default 'name',     -- name | contact | no_shows | created
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
  -- The sortable columns, written once. The key is what the URL carries;
  -- the value is the expression. Anything else is refused (22023).
  c_sorts constant jsonb := jsonb_build_object(
    'name',     'lower(c.last_name || '', '' || c.first_name)',
    'contact',  'coalesce(lower(c.email), c.phone)',
    'no_shows', 'c.no_show_count',
    'created',  'c.created_at'
  );
  v_words    text[] := search_words(p_q);
  v_patterns text[] := '{}';   -- $1: one escaped %word% per word
  v_phones   text[] := '{}';   -- $2: the word's digits as %digits%, or null
  v_digits   text;
  v_where    text := ' where c.organization_id = current_org_id()';
  v_size     integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_page     integer := greatest(coalesce(p_page, 1), 1);
  v_total    bigint;
  v_rows     jsonb;
begin
  -- The signal. RLS is the backstop and would return nothing; this says why.
  if not has_permission('clients.view') then
    raise exception 'clients.view required' using errcode = 'insufficient_privilege';
  end if;
  if not c_sorts ? coalesce(p_sort, '') then
    raise exception 'Unknown sort: %', p_sort using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_active, '') not in ('active', 'inactive', 'all') then
    raise exception 'Unknown active filter: %', p_active using errcode = 'invalid_parameter_value';
  end if;

  -- Each word matches a name, the email, or (three or more digits) the
  -- phone's digits. AND across words, OR across fields. The text only
  -- ever reaches the query as a bound parameter.
  for i in 1 .. coalesce(array_length(v_words, 1), 0) loop
    v_patterns := v_patterns || search_like_pattern(v_words[i]);
    v_digits := regexp_replace(v_words[i], '\D', '', 'g');
    v_phones := v_phones || (case when length(v_digits) >= 3 then '%' || v_digits || '%' end);
    v_where := v_where || format('
      and (c.first_name ilike $1[%1$s] or c.last_name ilike $1[%1$s] or c.email ilike $1[%1$s]
        or ($2[%1$s] is not null and regexp_replace(coalesce(c.phone, ''''), ''\D'', '''', ''g'') like $2[%1$s]))', i);
  end loop;
  if p_active = 'active' then v_where := v_where || ' and c.active'; end if;
  if p_active = 'inactive' then v_where := v_where || ' and not c.active'; end if;

  -- The matches are found once, for both the total and the page. Only
  -- their ids and sort keys are sorted and cut; the JSON is built for the
  -- page's rows only. The id is a stable tiebreak.
  execute format($q$
    with matched as materialized (
      select c.id, %2$s as s from clients c %1$s
    ), page as (
      select x.id, row_number() over (order by x.s %3$s nulls last, x.id %3$s) as n
      from (select id, s from matched order by s %3$s nulls last, id %3$s limit %4$s offset %5$s) x
    )
    select (select count(*) from matched),
           (select coalesce(jsonb_agg(jsonb_build_object(
              'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
              'email', c.email, 'phone', c.phone, 'active', c.active,
              'no_show_count', c.no_show_count,
              'requires_card_on_file', coalesce((c.flags ->> 'requires_card_on_file')::boolean, false)
            ) order by page.n), '[]'::jsonb)
            from clients c join page on page.id = c.id)
  $q$, v_where, c_sorts ->> p_sort, case when p_desc then 'desc' else 'asc' end, v_size, (v_page - 1) * v_size)
    into v_total, v_rows using v_patterns, v_phones;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_exact', true);
end;
$$;

comment on function clients_page(text, text, text, boolean, integer, integer) is
  'One page of the caller''s organisation''s clients, searched (name, email, phone digits), filtered (active), sorted and paged in Postgres: {rows, total, total_exact}. SECURITY INVOKER: RLS applies; raises 42501 without clients.view, 22023 on an unknown sort or filter. Returns only what the list shows.';

revoke execute on function clients_page(text, text, text, boolean, integer, integer) from public, anon;
grant execute on function clients_page(text, text, text, boolean, integer, integer) to authenticated, service_role;
