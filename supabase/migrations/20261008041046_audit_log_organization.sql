-- ============================================================
-- Migration: audit_log carries its organisation; append-only for
-- every role
-- npx supabase migration new audit_log_organization
-- ============================================================
-- docs/design/policy-sweep-design.md, "The audit_log organisation
-- column". audit_read had no organisation term because the table had
-- no organization_id: any holder of audit_log.view in any organisation
-- could read every organisation's rows. Closed here before a second
-- organisation can exist.
--
-- Backfill: the organisation of the entity the row is about, by
-- entity_type, falling back to the actor's staff row. Hosted on
-- 2026-10-08: 127 rows — 76 by entity, 21 by actor, 30 by neither.
--
-- THE 30, DELETED, NARROWLY: staff_role.granted / staff_role.revoked
-- rows with no actor, about a staff id that no longer exists, written
-- between 2026-10-05 23:55 and 2026-10-07 00:10 UTC. They are hosted
-- harness residue: verify-tables created test staff, granted roles
-- (the staff_roles trigger wrote these, with current_staff_id() null
-- under the service role) and deleted the staff, and its cleanup
-- removed only the rows the test staff WROTE. Not events in the
-- organisation's history. The delete asserts it removed exactly 30
-- rows on hosted (or 0 on a stack built fresh from the migrations,
-- which never had them) and raises otherwise, so a differing count
-- removes nothing. After this, hosted harness runs never write into an
-- append-only table (CLAUDE.md, docs/testing-design.md).
--
-- The append-only block becomes ONE shared function whose message
-- names the table; the ledger's three triggers move onto it and
-- ledger_block_change is dropped. Created LAST, after the backfill.

-- ------------------------------------------------------------
-- 1. ONE append-only block, for the ledger and the audit log
-- ------------------------------------------------------------
create or replace function append_only_block()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: rows are never edited or removed (% refused)', tg_table_name, tg_op
    using errcode = 'LD003';
end $$;

drop trigger trg_transactions_append_only      on transactions;
drop trigger trg_transaction_items_append_only on transaction_items;
drop trigger trg_payments_append_only          on payments;
create trigger trg_transactions_append_only
  before update or delete on transactions      for each row execute function append_only_block();
create trigger trg_transaction_items_append_only
  before update or delete on transaction_items for each row execute function append_only_block();
create trigger trg_payments_append_only
  before update or delete on payments          for each row execute function append_only_block();
drop function ledger_block_change();

-- ------------------------------------------------------------
-- 2. THE COLUMN, THE BACKFILL, THE 30, NOT NULL, THE INDEX
-- ------------------------------------------------------------
alter table audit_log add column organization_id uuid references organizations(id) on delete restrict;

update audit_log a set organization_id = coalesce(
  case a.entity_type
    when 'appointment'         then (select organization_id from appointments        where id = a.entity_id)
    when 'client'              then (select organization_id from clients             where id = a.entity_id)
    when 'communications_sent' then (select organization_id from communications_sent where id = a.entity_id)
    when 'leads'               then (select organization_id from leads               where id = a.entity_id)
    when 'prospect_intake'     then (select organization_id from prospect_intake     where id = a.entity_id)
    when 'staff'               then (select organization_id from staff               where id = a.entity_id)
    when 'transaction'         then (select organization_id from transactions        where id = a.entity_id)
  end,
  (select organization_id from staff s where s.id = a.actor_staff_id));

do $$
declare v_removed integer;
begin
  delete from audit_log a
   where a.organization_id is null
     and a.action in ('staff_role.granted', 'staff_role.revoked')
     and a.actor_staff_id is null
     and a.entity_type = 'staff'
     and not exists (select 1 from staff s where s.id = a.entity_id)
     and a.occurred_at >= '2026-10-05 23:55:00+00'
     and a.occurred_at <  '2026-10-07 00:11:00+00';
  get diagnostics v_removed = row_count;
  if v_removed not in (0, 30) then
    raise exception 'audit_log orphan cleanup matched % rows, expected the 30 hosted residue rows (or 0 on a fresh stack); nothing removed', v_removed;
  end if;
  if exists (select 1 from audit_log where organization_id is null) then
    raise exception 'audit_log backfill left % row(s) unresolved', (select count(*) from audit_log where organization_id is null);
  end if;
end $$;

alter table audit_log alter column organization_id set not null;
create index audit_log_org_time on audit_log (organization_id, occurred_at desc);

comment on column audit_log.organization_id is
  'The organisation the entry belongs to: the entity''s, else the actor''s. Every writer sets it from a row it holds (never current_org_id()); the staff_roles trigger from the staff row, else the role''s; accept_staff_invite from the invite. audit_read scopes on it.';

-- ------------------------------------------------------------
-- 3. THE POLICY
-- ------------------------------------------------------------
alter policy audit_read on audit_log
  using (organization_id = (select current_org_id()) and (select has_permission('audit_log.view')));

-- ------------------------------------------------------------
-- 4. THE TWO SQL WRITERS
-- ------------------------------------------------------------
-- The organisation from the staff row, else from the role: a role
-- assignment removed by the cascade of its staff row's deletion fires
-- this after the staff row is gone, and the role still knows. Neither
-- resolving is impossible and fails the not null, loudly.
create or replace function audit_staff_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (organization_id, actor_staff_id, actor_user_id, action, entity_type, entity_id, detail)
    values (coalesce((select organization_id from staff where id = new.staff_id),
                     (select organization_id from roles where id = new.role_id)),
            current_staff_id(), auth.uid(), 'staff_role.granted', 'staff', new.staff_id,
            jsonb_build_object('role_id', new.role_id));
    return new;
  elsif tg_op = 'DELETE' then
    insert into audit_log (organization_id, actor_staff_id, actor_user_id, action, entity_type, entity_id, detail)
    values (coalesce((select organization_id from staff where id = old.staff_id),
                     (select organization_id from roles where id = old.role_id)),
            current_staff_id(), auth.uid(), 'staff_role.revoked', 'staff', old.staff_id,
            jsonb_build_object('role_id', old.role_id));
    return old;
  end if;
  return null;
end;
$$;

-- accept_staff_invite, reproduced in full from 20260809012302 with only
-- its audit insert changed. Same signature: the grants (service_role
-- only) are kept by create or replace.
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

  insert into audit_log (organization_id, actor_user_id, action, entity_type, entity_id, detail)
  values (inv.organization_id, new_user_id, 'staff.invite_accepted', 'staff', new_staff_id,
          jsonb_build_object('invite_id', inv.id, 'email', inv.email));

  return new_staff_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. APPEND-ONLY FOR EVERY ROLE — last, after the backfill
-- ------------------------------------------------------------
create trigger trg_audit_log_append_only
  before update or delete on audit_log
  for each row execute function append_only_block();
revoke truncate on audit_log from service_role;

comment on table audit_log is
  'Who did what, to which record, when — one row per sensitive action. Append-only for EVERY role, the service role included (trg_audit_log_append_only; the API roles also lack update and delete). Scoped to the organisation by organization_id, set by every writer from a row it holds.';
