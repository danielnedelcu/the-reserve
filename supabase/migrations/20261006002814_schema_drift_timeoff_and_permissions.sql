-- ============================================================
-- Migration: schema drift — two functions and a trigger that existed
--            only on the hosted project
-- npx supabase migration new schema_drift_timeoff_and_permissions
--
-- Found 2026-10-05 by comparing the hosted project against a stack
-- rebuilt from supabase/migrations/ (docs/testing-design.md, the grants
-- work): get_my_permissions(), notify_timeoff_requested() and its
-- trigger reached hosted through the SQL editor and were never captured.
-- Without the first, usePermissions() loads nothing and every can()
-- denies; without the second, time-off requests raise no bell.
--
-- Definitions are verbatim from hosted (pg_get_functiondef). Idempotent
-- there on purpose: create or replace, and drop trigger if exists before
-- create trigger, so the push is a no-op on hosted and a repair on any
-- stack built from the migrations alone. (notify_timeoff_requested is
-- captured AS IT WAS; the multi-tenancy fix is the next migration, so
-- the record shows what hosted actually ran.)
-- ============================================================

-- ------------------------------------------------------------
-- get_my_permissions: the caller's permission keys, for usePermissions()
-- ------------------------------------------------------------

create or replace function get_my_permissions()
returns setof text
language sql
stable security definer set search_path = public
as $$
  select distinct rp.permission_key
  from staff_roles sr
  join role_permissions rp on rp.role_id = sr.role_id
  where sr.staff_id = current_staff_id();
$$;

comment on function get_my_permissions() is
  'The signed-in staff member''s permission keys, read once per session by usePermissions() to drive can(). Security definer so the join over staff_roles and role_permissions needs no policy of its own. Existed on the hosted project with no migration; captured 2026-10-05.';

-- ------------------------------------------------------------
-- notify_timeoff_requested: the bell for approvers on a new request
-- ------------------------------------------------------------

create or replace function notify_timeoff_requested()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  tz text;
  requester_name text;
begin
  if new.status = 'requested' then
    select timezone into tz from locations limit 1;
    tz := coalesce(tz, 'America/Los_Angeles');
    select display_name into requester_name from staff where id = new.staff_id;

    -- Notify every active staff member who can approve time off…
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
    where rp.permission_key = 'timeoff.approve'
      and s.active
      and s.id <> new.staff_id;  -- …except the requester themselves
  end if;
  return new;
end;
$$;

comment on function notify_timeoff_requested() is
  'After-insert trigger function on availability_exceptions: a new request (status = requested) raises one timeoff.requested notification for every active holder of timeoff.approve other than the requester. Existed on the hosted project with no migration; captured 2026-10-05.';

drop trigger if exists trg_notify_timeoff_requested on availability_exceptions;
create trigger trg_notify_timeoff_requested
  after insert on availability_exceptions
  for each row execute function notify_timeoff_requested();

comment on trigger trg_notify_timeoff_requested on availability_exceptions is
  'Bell fan-out for a new time-off request. Existed on the hosted project with no migration; captured 2026-10-05.';
