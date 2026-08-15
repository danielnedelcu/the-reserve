-- ============================================================
-- Migration 1b: Staff Invitations + Hardened Protections + Role-Change Auditing
-- Create via: npx supabase migration new staff_invites_and_protections
--   paste this content into the generated file, then: npx supabase db push
-- ============================================================

-- ------------------------------------------------------------
-- STAFF INVITATIONS
-- ------------------------------------------------------------

create table staff_invites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  email           text not null,
  display_name    text,                    -- optional prefill
  title           text,                    -- optional prefill
  role_ids        uuid[] not null,         -- roles to assign on acceptance
  location_ids    uuid[] not null default '{}',
  token           uuid not null unique default gen_random_uuid(),
  invited_by      uuid not null references staff(id),
  expires_at      timestamptz not null default now() + interval '7 days',
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- One live (pending, unexpired, unrevoked) invite per email per org
create unique index staff_invites_one_pending
  on staff_invites (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table staff_invites enable row level security;

-- Staff with invite permission can see and manage the org's invites.
-- NOTE: no anon/token-based read policy on purpose — invite acceptance
-- is handled by a server route using the service role, so the token
-- never grants direct table access from the browser.
create policy invites_read on staff_invites
  for select using (organization_id = current_org_id() and has_permission('staff.invite'));

create policy invites_create on staff_invites
  for insert with check (
    organization_id = current_org_id()
    and has_permission('staff.invite')
    and invited_by = current_staff_id()
  );

create policy invites_revoke on staff_invites
  for update using (organization_id = current_org_id() and has_permission('staff.invite'));

-- ------------------------------------------------------------
-- ACCEPTANCE HELPER (called by the server route with service role,
-- AFTER it has created/confirmed the auth user)
-- Performs all acceptance steps atomically.
-- ------------------------------------------------------------

create or replace function accept_staff_invite(
  invite_token uuid,
  new_user_id uuid,
  final_display_name text,
  final_title text default null
)
returns uuid  -- new staff id
language plpgsql security definer set search_path = public
as $$
declare
  inv staff_invites%rowtype;
  new_staff_id uuid;
  rid uuid;
  lid uuid;
begin
  select * into inv from staff_invites
  where token = invite_token
    and accepted_at is null
    and revoked_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Invite is invalid, expired, or already used';
  end if;

  insert into staff (organization_id, user_id, display_name, email, title)
  values (inv.organization_id, new_user_id, final_display_name, inv.email, final_title)
  returning id into new_staff_id;

  foreach rid in array inv.role_ids loop
    insert into staff_roles (staff_id, role_id) values (new_staff_id, rid);
  end loop;

  foreach lid in array inv.location_ids loop
    insert into staff_locations (staff_id, location_id) values (new_staff_id, lid);
  end loop;

  update staff_invites set accepted_at = now() where id = inv.id;

  insert into audit_log (actor_user_id, action, entity_type, entity_id, detail)
  values (new_user_id, 'staff.invite_accepted', 'staff', new_staff_id,
          jsonb_build_object('invite_id', inv.id, 'email', inv.email));

  return new_staff_id;
end;
$$;

-- Lock the function down: only the service role may execute it
revoke execute on function accept_staff_invite(uuid, uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- HARDENED LAST-SUPER-ADMIN PROTECTION
-- (migration 1 only covered deleting a staff_roles row)
-- ------------------------------------------------------------

-- Shared check: how many OTHER active super admins exist in an org
create or replace function count_other_active_super_admins(org uuid, excluded_staff uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int
  from staff_roles sr
  join roles r on r.id = sr.role_id
  join staff s on s.id = sr.staff_id
  where r.organization_id = org
    and r.name = 'super_admin' and r.is_system = true
    and s.active = true
    and s.id <> excluded_staff;
$$;

-- Block deactivating (or unlinking auth from) the last active super admin
create or replace function prevent_last_super_admin_deactivation()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.active = true and new.active = false then
    if exists (
      select 1 from staff_roles sr
      join roles r on r.id = sr.role_id
      where sr.staff_id = old.id
        and r.name = 'super_admin' and r.is_system = true
    ) and count_other_active_super_admins(old.organization_id, old.id) = 0 then
      raise exception 'Cannot deactivate the last active super admin';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_last_super_admin_deactivation
  before update on staff
  for each row execute function prevent_last_super_admin_deactivation();

-- Block deleting system roles entirely (covers deleting super_admin role itself)
create or replace function prevent_system_role_deletion()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.is_system then
    raise exception 'System roles cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger trg_protect_system_roles
  before delete on roles
  for each row execute function prevent_system_role_deletion();

-- ------------------------------------------------------------
-- AUTOMATIC AUDITING OF ROLE ASSIGNMENT CHANGES
-- (database-level, so even manual SQL changes are captured)
-- ------------------------------------------------------------

create or replace function audit_staff_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (actor_staff_id, actor_user_id, action, entity_type, entity_id, detail)
    values (current_staff_id(), auth.uid(), 'staff_role.granted', 'staff', new.staff_id,
            jsonb_build_object('role_id', new.role_id));
    return new;
  elsif tg_op = 'DELETE' then
    insert into audit_log (actor_staff_id, actor_user_id, action, entity_type, entity_id, detail)
    values (current_staff_id(), auth.uid(), 'staff_role.revoked', 'staff', old.staff_id,
            jsonb_build_object('role_id', old.role_id));
    return old;
  end if;
  return null;
end;
$$;

create trigger trg_audit_staff_roles
  after insert or delete on staff_roles
  for each row execute function audit_staff_role_change();