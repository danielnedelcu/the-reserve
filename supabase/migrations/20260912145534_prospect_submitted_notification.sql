-- ============================================================
-- Migration: a submitted prospect reaches the people who review them
-- npx supabase migration new prospect_submitted_notification
--
-- Three things, all so the review queue is noticed rather than polled,
-- and stops demanding attention the moment it is handled:
--
--   1. A trigger on prospect_intake INSERT fans a notification out to
--      every ACTIVE staff member in the prospect's organisation who holds
--      forms.responses.view — the same key that gates /intake, the review
--      route, and the prospect_intake read policy. A trigger rather than
--      route code because the insert happens inside submit_form_response
--      under the service role, and a notification written by the fact
--      of the row (not by whichever caller inserted it) cannot be
--      forgotten by a future second insert path. Same philosophy as
--      notify_timeoff_decision and notify_message_received.
--
--   2. A trigger on the DECISION marks those notifications read. The
--      fan-out reaches every reviewer; one of them decides; without this
--      the others' bells stay lit for up to 30 days pointing at a settled
--      case. Read, not deleted: the entry remains as history and its link
--      still resolves (decided prospects stay viewable until the purge).
--      Same shape as mark_conversation_read clearing message.received.
--
--   3. prospect_intake joins the realtime publication, so the nav
--      indicator for "prospects awaiting review" can re-count the moment
--      a row arrives or is decided, instead of on the next page load.
--      RLS applies over Realtime exactly as over PostgREST: a subscriber
--      receives change events only for rows their policy lets them SELECT,
--      and the read policy already requires forms.responses.view.
--
-- Recipient selection here and the client's can('forms.responses.view')
-- gate decide the same predicate in two languages. They cannot share an
-- implementation, so verify:forms asserts they AGREE: after a submit, the
-- set of staff holding a prospect.submitted notification equals the set
-- of active staff with the permission, and staff without it hold none.
-- ============================================================

create or replace function notify_prospect_submitted()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into notifications (staff_id, kind, title, body, link)
  select distinct s.id,
         'prospect.submitted',
         'New member application',
         new.first_name || ' ' || new.last_name || ' sent an intake form',
         '/intake/' || new.id
    from staff s
    join staff_roles sr on sr.staff_id = s.id
    join role_permissions rp on rp.role_id = sr.role_id
   where s.organization_id = new.organization_id
     and s.active
     and rp.permission_key = 'forms.responses.view';
  return new;
end;
$$;

comment on function notify_prospect_submitted() is
  'AFTER INSERT on prospect_intake: one prospect.submitted notification per active staff member in the org holding forms.responses.view, linking to /intake/<id>. Recipients are chosen by permission, not by role name, so a new role that gains the permission is notified without a migration.';

create trigger trg_notify_prospect_submitted
  after insert on prospect_intake
  for each row execute function notify_prospect_submitted();

-- Decided means done: approve OR reject settles the notification, for
-- everyone it was fanned out to, not only the person who clicked.
create or replace function settle_prospect_notifications()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('approved', 'rejected')
     and old.status not in ('approved', 'rejected') then
    update notifications
       set read_at = now()
     where kind = 'prospect.submitted'
       and link = '/intake/' || new.id
       and read_at is null;
  end if;
  return new;
end;
$$;

comment on function settle_prospect_notifications() is
  'AFTER UPDATE OF status on prospect_intake: when a prospect becomes approved or rejected, every unread prospect.submitted notification for it is marked read. under_review does not settle — the queue is still open.';

create trigger trg_settle_prospect_notifications
  after update of status on prospect_intake
  for each row execute function settle_prospect_notifications();

-- The notification links to a row that the 30-day purge (or a manual
-- delete) can remove. A bell entry pointing at a 404 is worse than no
-- entry, so the notification goes with the prospect.
create or replace function forget_prospect_notifications()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  delete from notifications
   where kind = 'prospect.submitted'
     and link = '/intake/' || old.id;
  return old;
end;
$$;

create trigger trg_forget_prospect_notifications
  after delete on prospect_intake
  for each row execute function forget_prospect_notifications();

-- ------------------------------------------------------------
-- Realtime: the awaiting-review count re-fetches on any change
-- ------------------------------------------------------------
alter publication supabase_realtime add table prospect_intake;
