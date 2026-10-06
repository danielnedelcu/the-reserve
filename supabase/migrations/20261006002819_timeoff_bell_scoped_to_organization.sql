-- ============================================================
-- Migration: scope the time-off bell to the requester's organisation
-- npx supabase migration new timeoff_bell_scoped_to_organization
--
-- A fix to notify_timeoff_requested() as captured from hosted in the
-- schema_drift migration. That definition had two multi-tenancy bugs:
--   1. it notified every active holder of timeoff.approve in EVERY
--      organisation — a request at one spa rang approvers at another;
--   2. it formatted the times in the zone of `locations limit 1`,
--      whichever organisation that row belonged to, with a hard-coded
--      America/Los_Angeles fallback.
-- availability_exceptions carries no organization_id, so the
-- organisation is the requester's staff row's. notifications carries
-- no organization_id either; nothing to set there. The zone is the
-- organisation's first active location's (by created_at, id as the
-- tiebreaker, so "first" is deterministic), else the organisation's own
-- timezone column. create or replace, so the push repairs hosted.
-- Proven by verify:messages' scoping check: two organisations, one
-- approver each, a request in one.
-- ============================================================

create or replace function notify_timeoff_requested()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  org uuid;
  tz text;
  requester_name text;
begin
  if new.status = 'requested' then
    select s.organization_id, s.display_name
      into org, requester_name
      from staff s
     where s.id = new.staff_id;

    select l.timezone into tz
      from locations l
     where l.organization_id = org and l.active
     order by l.created_at, l.id
     limit 1;
    if tz is null then
      select o.timezone into tz from organizations o where o.id = org;
    end if;
    tz := coalesce(tz, 'UTC');

    -- Every active approver in the requester's organisation, except the
    -- requester themselves.
    insert into notifications (staff_id, kind, title, body, link)
    select distinct s.id,
      'timeoff.requested',
      coalesce(requester_name, 'A staff member') || ' requested time off',
      to_char(new.starts_at at time zone tz, 'Mon FMDD, FMHH12:MI AM')
        || ' – ' || to_char(new.ends_at at time zone tz, 'Mon FMDD, FMHH12:MI AM'),
      '/time-off'
    from staff s
    join staff_roles sr on sr.staff_id = s.id
    join role_permissions rp on rp.role_id = sr.role_id
    where s.organization_id = org
      and rp.permission_key = 'timeoff.approve'
      and s.active
      and s.id <> new.staff_id;
  end if;
  return new;
end;
$$;

comment on function notify_timeoff_requested() is
  'After-insert trigger function on availability_exceptions: a new request (status = requested) raises one timeoff.requested notification for every active holder of timeoff.approve IN THE REQUESTER''S ORGANISATION, other than the requester. Times are formatted in that organisation''s first active location''s zone (by created_at, then id), else its own timezone. Fixes the captured definition, which notified approvers across all organisations and took its zone from an arbitrary location (2026-10-05).';
