-- ============================================================
-- Migration 1: Organizations, Staff, Permissions, Audit Log
-- Apply with: supabase db reset (local) / supabase db push (remote)
-- Generate via: supabase migration new init_org_auth_permissions
--   then paste this content into the created file.
-- ============================================================

-- ------------------------------------------------------------
-- ORG STRUCTURE
-- ------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'America/Los_Angeles',
  branding    jsonb not null default '{}'::jsonb,  -- logo url, colors
  created_at  timestamptz not null default now()
);

create table locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  timezone        text not null,
  business_hours  jsonb,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- STAFF
-- ------------------------------------------------------------

create table staff (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  user_id         uuid unique references auth.users(id) on delete set null,
  display_name    text not null,
  email           text not null,
  title           text,
  color           text,
  bookable        boolean not null default true,
  active          boolean not null default true,
  hired_at        date,
  created_at      timestamptz not null default now()
);

create table staff_locations (
  staff_id    uuid not null references staff(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  primary key (staff_id, location_id)
);

-- ------------------------------------------------------------
-- PERMISSION SYSTEM (roles as data)
-- ------------------------------------------------------------

create table roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  is_system       boolean not null default false,
  unique (organization_id, name)
);

create table permissions (
  key         text primary key,
  description text not null
);

create table role_permissions (
  role_id        uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table staff_roles (
  staff_id uuid not null references staff(id) on delete cascade,
  role_id  uuid not null references roles(id) on delete cascade,
  primary key (staff_id, role_id)
);

-- ------------------------------------------------------------
-- HELPER FUNCTIONS (used by RLS policies and app queries)
-- ------------------------------------------------------------

-- The staff row for the currently authenticated user
create or replace function current_staff_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from staff where user_id = auth.uid() and active = true;
$$;

create or replace function current_org_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select organization_id from staff where user_id = auth.uid() and active = true;
$$;

create or replace function has_permission(perm text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from staff_roles sr
    join role_permissions rp on rp.role_id = sr.role_id
    where sr.staff_id = current_staff_id()
      and rp.permission_key = perm
  );
$$;

-- ------------------------------------------------------------
-- AUDIT LOG (append-only)
-- ------------------------------------------------------------

create table audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_staff_id uuid references staff(id),
  actor_user_id  uuid,
  action      text not null,          -- e.g. 'refund.issued', 'health_note.viewed'
  entity_type text,                   -- e.g. 'appointment'
  entity_id   uuid,
  detail      jsonb
);

-- No update/delete policies will ever be created: append-only by construction.
revoke update, delete on audit_log from authenticated, anon;

-- ------------------------------------------------------------
-- LAST-SUPER-ADMIN LOCKOUT PROTECTION
-- ------------------------------------------------------------

create or replace function prevent_last_super_admin_removal()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  role_org uuid;
  remaining int;
begin
  select organization_id into role_org from roles
  where id = old.role_id and name = 'super_admin' and is_system = true;

  if role_org is null then
    return old; -- not a super_admin role, allow
  end if;

  select count(*) into remaining
  from staff_roles sr
  join roles r on r.id = sr.role_id
  join staff s on s.id = sr.staff_id
  where r.organization_id = role_org
    and r.name = 'super_admin' and r.is_system = true
    and s.active = true
    and not (sr.staff_id = old.staff_id and sr.role_id = old.role_id);

  if remaining = 0 then
    raise exception 'Cannot remove the last active super admin';
  end if;

  return old;
end;
$$;

create trigger trg_last_super_admin
  before delete on staff_roles
  for each row execute function prevent_last_super_admin_removal();

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table organizations   enable row level security;
alter table locations       enable row level security;
alter table staff           enable row level security;
alter table staff_locations enable row level security;
alter table roles           enable row level security;
alter table permissions     enable row level security;
alter table role_permissions enable row level security;
alter table staff_roles     enable row level security;
alter table audit_log       enable row level security;

-- Everyone in the org can read org structure and the staff directory
create policy org_read on organizations
  for select using (id = current_org_id());

create policy org_manage on organizations
  for update using (id = current_org_id() and has_permission('org.settings.manage'));

create policy locations_read on locations
  for select using (organization_id = current_org_id());

create policy locations_manage on locations
  for all using (organization_id = current_org_id() and has_permission('org.settings.manage'));

create policy staff_read on staff
  for select using (organization_id = current_org_id() and has_permission('staff.view'));

create policy staff_insert on staff
  for insert with check (organization_id = current_org_id() and has_permission('staff.invite'));

create policy staff_update on staff
  for update using (organization_id = current_org_id() and has_permission('staff.edit'));

create policy staff_locations_read on staff_locations
  for select using (
    exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );

create policy staff_locations_manage on staff_locations
  for all using (
    has_permission('staff.edit')
    and exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );

-- Permission catalog is global and readable by any authenticated user
create policy permissions_read on permissions
  for select to authenticated using (true);

create policy roles_read on roles
  for select using (organization_id = current_org_id());

create policy roles_manage on roles
  for all using (organization_id = current_org_id() and has_permission('roles.manage'));

create policy role_permissions_read on role_permissions
  for select using (
    exists (select 1 from roles r where r.id = role_id and r.organization_id = current_org_id())
  );

create policy role_permissions_manage on role_permissions
  for all using (
    has_permission('roles.manage')
    and exists (select 1 from roles r where r.id = role_id and r.organization_id = current_org_id())
  );

create policy staff_roles_read on staff_roles
  for select using (
    exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );

create policy staff_roles_manage on staff_roles
  for all using (
    has_permission('roles.manage')
    and exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );

-- Audit log: super-admin read; inserts happen via server routes (service role)
create policy audit_read on audit_log
  for select using (has_permission('audit_log.view'));

-- ------------------------------------------------------------
-- SEED: PERMISSIONS (matches requirements doc Appendix A)
-- ------------------------------------------------------------

insert into permissions (key, description) values
  -- Appointments
  ('appointments.view.own',          'View own appointments'),
  ('appointments.view.any',          'View all appointments (org calendar)'),
  ('appointments.create',            'Create appointments'),
  ('appointments.edit.own',          'Edit own appointments'),
  ('appointments.edit.any',          'Edit any appointment'),
  ('appointments.cancel.any',        'Cancel any appointment'),
  ('appointments.override_conflicts','Override booking conflicts'),
  -- Clients
  ('clients.view',                   'View clients'),
  ('clients.create',                 'Create clients'),
  ('clients.edit',                   'Edit clients'),
  ('clients.notes.health.view',      'View client health notes'),
  ('clients.notes.health.create',    'Create client health notes'),
  ('clients.export',                 'Export client data'),
  ('clients.delete',                 'Delete clients'),
  -- Schedule & availability
  ('availability.edit.own',          'Edit own availability'),
  ('availability.edit.any',          'Edit anyone''s availability'),
  ('timeoff.request',                'Request time off'),
  ('timeoff.approve',                'Approve time off'),
  -- Staff management
  ('staff.view',                     'View staff directory'),
  ('staff.invite',                   'Invite new employees'),
  ('staff.edit',                     'Edit staff profiles'),
  ('staff.deactivate',               'Deactivate staff'),
  ('roles.manage',                   'Manage roles and permissions'),
  -- Service catalog
  ('services.view',                  'View services'),
  ('services.manage',                'Manage services, rooms, and pricing'),
  -- Payments & memberships
  ('payments.take',                  'Take payments (POS)'),
  ('payments.refund',                'Issue refunds'),
  ('memberships.manage',             'Manage memberships'),
  ('memberships.comp',               'Comp or discount memberships'),
  -- Financials
  ('financials.view_summary',        'View financial summary'),
  ('financials.view_detail',         'View financial detail'),
  ('financials.view_own_earnings',   'View own earnings and commissions'),
  ('financials.export',              'Export financial data'),
  -- Marketing & forms
  ('forms.manage',                   'Create and manage feedback forms'),
  ('forms.send',                     'Send forms to clients'),
  ('forms.responses.view',           'View form responses'),
  -- Analytics
  ('analytics.view.org',             'View org-wide analytics'),
  ('analytics.view.own',             'View own performance analytics'),
  -- Messaging
  ('messages.send',                  'Send direct and group messages'),
  ('messages.broadcast',             'Send org-wide broadcasts'),
  -- System
  ('audit_log.view',                 'View the audit log'),
  ('org.settings.manage',            'Manage org settings and branding');

-- ------------------------------------------------------------
-- SEED: DEMO ORG + SYSTEM ROLES + ROLE-PERMISSION MAPPINGS
-- (Rename the org; roles/permissions mapping mirrors Appendix A)
-- ------------------------------------------------------------

do $$
declare
  org uuid;
  r_super uuid; r_admin uuid; r_desk uuid; r_provider uuid;
begin
  insert into organizations (name, timezone)
  values ('The Reserve', 'America/Los_Angeles')
  returning id into org;

  insert into roles (organization_id, name, is_system) values
    (org, 'super_admin', true) returning id into r_super;
  insert into roles (organization_id, name, is_system) values
    (org, 'admin', true) returning id into r_admin;
  insert into roles (organization_id, name, is_system) values
    (org, 'front_desk', true) returning id into r_desk;
  insert into roles (organization_id, name, is_system) values
    (org, 'provider', true) returning id into r_provider;

  -- Super admin: everything
  insert into role_permissions (role_id, permission_key)
    select r_super, key from permissions;

  -- Admin: everything except role management, client delete,
  -- financial export, audit log, org settings
  insert into role_permissions (role_id, permission_key)
    select r_admin, key from permissions
    where key not in (
      'roles.manage','clients.delete','financials.export',
      'audit_log.view','org.settings.manage'
    );

  -- Front desk
  insert into role_permissions (role_id, permission_key)
    select r_desk, unnest(array[
      'appointments.view.own','appointments.view.any','appointments.create',
      'appointments.edit.own','appointments.edit.any','appointments.cancel.any',
      'clients.view','clients.create','clients.edit',
      'timeoff.request',
      'staff.view','services.view',
      'payments.take','memberships.manage',
      'messages.send'
    ]);

  -- Provider
  insert into role_permissions (role_id, permission_key)
    select r_provider, unnest(array[
      'appointments.view.own','appointments.view.any','appointments.create',
      'appointments.edit.own',
      'clients.view','clients.notes.health.view','clients.notes.health.create',
      'availability.edit.own','timeoff.request',
      'staff.view','services.view',
      'financials.view_own_earnings','analytics.view.own',
      'messages.send'
    ]);
end $$;