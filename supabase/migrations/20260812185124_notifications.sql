-- ============================================================
-- Migration: in-app notifications
-- npx supabase migration new notifications
--
-- Generic notifications table (staff recipients), RLS, a trigger
-- that creates a notification whenever a time-off request is
-- decided, and realtime publication so the bell updates live.
-- ============================================================

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff(id) on delete cascade,
  kind       text not null,          -- 'timeoff.approved', 'timeoff.denied', ...
  title      text not null,
  body       text,
  link       text,                   -- in-app destination
  read_at    timestamptz,            -- null = unread
  created_at timestamptz not null default now()
);

create index notifications_staff on notifications (staff_id, created_at desc);
create index notifications_unread on notifications (staff_id) where read_at is null;

alter table notifications enable row level security;

-- Recipients see and mark-read ONLY their own notifications.
create policy notifications_read on notifications
  for select using (staff_id = current_staff_id());
create policy notifications_update on notifications
  for update using (staff_id = current_staff_id());
-- No insert/delete policies for authenticated users: rows are created by
-- triggers (security definer) or the service role only.

-- ------------------------------------------------------------
-- Trigger: time-off decision -> notification
-- Fires on the STATUS FACT changing, regardless of which UI or
-- SQL changed it (same philosophy as the no-show counter).
-- ------------------------------------------------------------
create or replace function notify_timeoff_decision()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  tz text;
  kind_label text;
  range_label text;
begin
  if old.status = 'requested' and new.status in ('approved', 'denied') then
    select timezone into tz from locations limit 1;
    tz := coalesce(tz, 'America/Los_Angeles');

    kind_label := case new.kind
      when 'time_off'    then 'Time off'
      when 'sick'        then 'Sick time'
      when 'extra_shift' then 'Extra shift'
      when 'break'       then 'Break'
      else new.kind
    end;

    range_label := to_char(new.starts_at at time zone tz, 'Mon FMDD, FMHH12:MI AM')
      || ' – ' || to_char(new.ends_at at time zone tz, 'Mon FMDD, FMHH12:MI AM');

    insert into notifications (staff_id, kind, title, body, link)
    values (
      new.staff_id,
      'timeoff.' || new.status,
      kind_label || ' ' ||
        case new.status when 'approved' then 'approved' else 'denied' end,
      range_label,
      '/staff/' || new.staff_id
    );
  end if;
  return new;
end;
$$;

create trigger trg_notify_timeoff_decision
  after update on availability_exceptions
  for each row execute function notify_timeoff_decision();

-- ------------------------------------------------------------
-- Realtime: publish inserts so the bell updates live.
-- (RLS applies to realtime too — recipients only receive their own rows.)
-- ------------------------------------------------------------
alter publication supabase_realtime add table notifications;