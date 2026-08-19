-- ============================================================
-- Migration: business settings (idempotent rerun after partial apply)
-- ============================================================

insert into permissions (key, description) values
  ('organization.manage', 'Edit business settings: location details, tax rate, timezone, organization name')
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select id, 'organization.manage' from roles where name = 'super_admin'
on conflict do nothing;

alter table locations
  add column if not exists phone         text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city          text,
  add column if not exists state         text,
  add column if not exists postal_code   text;

comment on column locations.timezone is
  'IANA timezone driving availability math and notification formatting. Change with care: weekly hours are interpreted in this zone.';

-- Distinct names: a "locations_manage" policy already exists from migration 1.
drop policy if exists locations_business_manage on locations;
create policy locations_business_manage on locations
  for update using (
    organization_id = current_org_id() and has_permission('organization.manage')
  );

drop policy if exists organizations_business_manage on organizations;
create policy organizations_business_manage on organizations
  for update using (
    id = current_org_id() and has_permission('organization.manage')
  );