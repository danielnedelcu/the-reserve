-- ============================================================
-- Migration: Ask The Reserve (phase 1) — read-only query role,
--            execution RPC, and the ask audit log
-- npx supabase migration new ask_readonly_role
--
-- The safety boundary for LLM-generated SQL, as data rather than as
-- prompt text: a role that can only SELECT, from an allowlist of
-- structured tables, inside a read-only transaction, with a timeout.
-- Prompt hardening sits on top of this; it is never the boundary.
-- ============================================================

-- ------------------------------------------------------------
-- THE ROLE
-- NOLOGIN on purpose: nothing ever connects as ask_readonly. The
-- execution RPC switches into it with SET LOCAL ROLE for the life of
-- one statement, so there is no password to provision, store, or
-- rotate — and no second connection string to leak.
--
-- Granted TO authenticated so the switch is legal from a normal user
-- session. The direction matters: authenticated gains the ability to
-- BECOME a strictly less privileged role. ask_readonly holds a subset
-- of what authenticated already holds, so membership grants nothing.
-- ------------------------------------------------------------
create role ask_readonly nologin noinherit;
grant ask_readonly to authenticated;

grant usage on schema public to ask_readonly;

-- RLS policies on the tables below call these; the role needs EXECUTE
-- to be able to satisfy its own policies.
grant execute on function current_staff_id()    to ask_readonly;
grant execute on function current_org_id()      to ask_readonly;
grant execute on function has_permission(text)  to ask_readonly;

-- ------------------------------------------------------------
-- THE ALLOWLIST
-- Grants ARE the allowlist — there is no string matching anywhere in
-- this feature deciding what may be read. Only the structured tables
-- the preset catalog and the design doc name appear here.
--
-- Deliberately absent, each for its own reason:
--   client_notes .......... health-tier notes are PHI. Note-text
--                           questions belong to the semantic phase;
--                           if one arrives early, the fallback is a
--                           kind <> 'health' VIEW, never the table.
--   messages, conversations, conversation_participants
--                           private staff comms, excluded from every
--                           corpus by standing decision
--   staff_invites ......... live invite tokens
--   card_consents, client_payment_methods, stripe_events
--                           payment identity surface; nothing here
--                           answers a business question
--   audit_log, ask_queries  the observers do not observe themselves
--   auth.*, storage.* ..... no grant on those schemas at all
-- ------------------------------------------------------------
grant select on
  organizations,
  locations,
  staff,
  clients,
  appointments,
  appointment_services,
  services,
  service_categories,
  service_staff,
  resources,
  resource_types,
  availability_rules,
  availability_exceptions,
  transactions,
  transaction_items,
  payments,
  gift_cards,
  products
to ask_readonly;

-- ------------------------------------------------------------
-- THE AUDIT LOG
-- Every ask is recorded with the SQL that ran, whether a human wrote
-- it (preset) or the model did. This is the record that makes a wrong
-- answer diagnosable after the fact.
-- ------------------------------------------------------------
create table ask_queries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  staff_id        uuid not null references staff(id),
  source          text not null check (source in ('preset','llm')),
  preset_id       text,
  question        text,
  generated_sql   text,
  row_count       int,
  duration_ms     int,
  error           text,
  created_at      timestamptz not null default now(),
  -- a preset carries its id; free text carries its question
  check ((source = 'preset') = (preset_id is not null))
);
comment on table ask_queries is
  'Append-only record of every Ask The Reserve question: the text asked, the SQL that ran, and what came back. No update/delete policies — a query log that can be edited is not a query log. Written by the /api/ask route; readable with ask.query. Rows with a non-null error are failed generations, which is the signal for prompt work.';
comment on column ask_queries.generated_sql is
  'The exact statement handed to ask_execute_sql, model-written or preset. Shown to the admin behind the "show the query" affordance and kept here for after-the-fact review.';

create index ask_queries_org_day on ask_queries (organization_id, created_at desc);
create index ask_queries_staff on ask_queries (staff_id, created_at desc);

-- ------------------------------------------------------------
-- THE EXECUTION RPC
-- SECURITY INVOKER, deliberately. A definer function would run as its
-- owner, and a RESET ROLE inside generated SQL would then escape UP.
-- As invoker, the floor is the caller's own `authenticated` role — the
-- same access that admin already has through the app — so the worst
-- case of a role escape is no worse than the status quo, and the
-- expected case is confined to the allowlist above.
--
-- Three layers, none of which is prompt text:
--   1. SET LOCAL ROLE   — the allowlist applies
--   2. read-only txn    — no write can be expressed, escape or not
--   3. statement_timeout — no runaway scan
-- ------------------------------------------------------------
create or replace function ask_execute_sql(p_sql text, p_limit int default 500)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
  if not has_permission('ask.query') then
    raise exception 'Missing permission: ask.query';
  end if;

  -- Single statement only. Not a security boundary (the role is), but
  -- it turns a malformed generation into a clear error instead of a
  -- confusing partial execution.
  if p_sql is null or btrim(p_sql) = '' then
    raise exception 'No query to run';
  end if;
  -- Strip trailing semicolons, then reject any that remain. A semicolon
  -- inside a string literal trips this too; that false positive is an
  -- acceptable trade for a check this simple, since it is not the boundary.
  if position(';' in rtrim(btrim(p_sql), ';')) > 0 then
    raise exception 'Only a single statement may be run';
  end if;
  if lower(btrim(p_sql)) !~ '^(select|with)\s' then
    raise exception 'Only SELECT queries may be run';
  end if;

  set local statement_timeout = '10s';
  set local transaction_read_only = on;
  set local role ask_readonly;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(capped)), ''[]''::jsonb)
       from (select * from (%s) generated limit %s) capped',
    p_sql, p_limit
  ) into result;

  return result;
end;
$$;
comment on function ask_execute_sql(text, int) is
  'Runs one read-only SELECT as ask_readonly and returns rows as jsonb. The role, the read-only transaction, and the timeout are the safety boundary; the statement checks here only produce better errors. Call it on the ASKING USER''S session (never the service role) so RLS scopes results to their org and permissions.';

-- anon has no business here; authenticated reaches it through the route
revoke execute on function ask_execute_sql(text, int) from public, anon;
grant execute on function ask_execute_sql(text, int) to authenticated;

-- ------------------------------------------------------------
-- PERMISSIONS
-- ask.query is its own key rather than a reuse of analytics.view.org:
-- this path reads across the whole allowlist, not just analytics, so
-- it needs to be grantable and revocable on its own.
-- ------------------------------------------------------------
insert into permissions (key, description) values
  ('ask.query', 'Ask questions about the business in plain English');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'ask.query'),
  ('admin',       'ask.query')
) as p(role_name, key) on p.role_name = r.name;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Reads by permission. Writes go through the /api/ask route only:
-- a log row the asker could forge is not evidence.
-- ------------------------------------------------------------
alter table ask_queries enable row level security;

create policy ask_queries_read on ask_queries
  for select using (organization_id = current_org_id() and has_permission('ask.query'));

-- No insert/update/delete policies for authenticated: the route writes
-- these rows with the service role, after the query has run.
