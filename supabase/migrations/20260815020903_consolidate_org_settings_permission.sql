-- Consolidates the accidental duplicate permission: 'organization.manage'
-- (minted in business_settings) retires in favor of migration 1's
-- 'org.settings.manage'. Applied manually via SQL editor on live first;
-- written idempotently so it no-ops there and applies cleanly on fresh DBs.

drop policy if exists locations_business_manage on locations;
drop policy if exists organizations_business_manage on organizations;
delete from role_permissions where permission_key = 'organization.manage';
delete from permissions where key = 'organization.manage';

drop policy if exists organizations_settings_manage on organizations;
create policy organizations_settings_manage on organizations
  for update using (id = current_org_id() and has_permission('org.settings.manage'));