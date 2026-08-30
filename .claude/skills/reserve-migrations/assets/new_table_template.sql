-- ============================================================
-- Migration: <what this adds, in plain words>
-- npx supabase migration new <snake_case_name>
-- <one or two lines on WHY, if the shape isn't self-evident>
-- ============================================================

-- ------------------------------------------------------------
-- <SECTION NAME IN CAPS>
-- ------------------------------------------------------------

create table <table_name> (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),

  -- domain columns; align the names, money in cents, enums as text + check
  name            text not null,
  kind            text not null check (kind in ('a','b')),
  amount_cents    int not null check (amount_cents >= 0),

  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),   -- drop if immutable

  unique (organization_id, name),
  check (<cross-column invariant, if any>)
);

-- Say what the INVARIANT is and why, not what the columns are. Mention
-- anything enforced by a trigger or by a deliberately missing policy —
-- this text is the schema's documentation (Supabase dashboard, docs/schema/).
comment on table <table_name> is
  '<one prose paragraph: what this holds, what is guaranteed about it, '
  'what is append-only or deactivated-never-deleted, what maintains it>.';

comment on column <table_name>.<column> is
  '<only for columns whose name under-sells them>';

-- Index for the queries the feature actually runs; partial where the
-- filter is constant.
create index <table_name>_<purpose> on <table_name> (organization_id, created_at desc);

-- Only if the table is mutable.
create trigger trg_<table_name>_touch
  before update on <table_name>
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------
-- PERMISSIONS
-- ------------------------------------------------------------
-- Check references/permissions.md first — do not mint a key that exists.

insert into permissions (key, description) values
  ('<domain>.view',   '<user-facing capability sentence>'),
  ('<domain>.manage', '<user-facing capability sentence>');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', '<domain>.view'), ('super_admin', '<domain>.manage'),
  ('admin',       '<domain>.view'), ('admin',       '<domain>.manage'),
  ('front_desk',  '<domain>.view')
) as p(role_name, key) on p.role_name = r.name;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- <one line on the write model: direct writes, or server-route only>
-- ------------------------------------------------------------

alter table <table_name> enable row level security;

create policy <table_name>_read on <table_name>
  for select using (organization_id = current_org_id() and has_permission('<domain>.view'));
create policy <table_name>_manage on <table_name>
  for all using (organization_id = current_org_id() and has_permission('<domain>.manage'));

-- If writes belong to a server route instead, omit the write policy and
-- replace it with the reason, e.g.:
-- No authenticated insert/update/delete policies: <operation> is multi-step
-- and prices/calls out mid-flight, so it lives in a server route under the
-- service role — same as the ledger.

-- If the table is append-only, say so where the policies would have been:
-- Append-only: no update/delete policies.

-- ------------------------------------------------------------
-- REALTIME (only if the UI subscribes)
-- ------------------------------------------------------------
-- alter publication supabase_realtime add table <table_name>;
