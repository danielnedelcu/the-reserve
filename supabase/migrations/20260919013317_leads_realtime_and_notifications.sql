-- ============================================================
-- Migration: leads go live — realtime publication + bell notifications
-- npx supabase migration new leads_realtime_and_notifications
--
-- Phase 3 of §8 (docs/design/leads-design.md): the staff UI gets a live
-- "leads needing attention" indicator and a bell entry when a lead
-- arrives. Two things this needs from the database:
--
--   1. `leads` joins the realtime publication. Phase 1 did not publish it
--      (nothing subscribed). The useProspectQueue docblock records what
--      happens when a client subscribes to a table that is NOT published:
--      Realtime accepts the subscription, reports SUBSCRIBED, and delivers
--      nothing until the socket rejoins. So the publication lands BEFORE
--      the indicator ships, and the composable re-counts on (re)join and
--      on tab-visible so tabs open across this push catch up on their
--      next reconnect rather than never. RLS applies over Realtime as over
--      PostgREST; the read policy already requires leads.view.
--
--   2. Three triggers, the prospect pattern exactly (20260912145534):
--      fan a lead.captured notification out to every active staff member
--      holding leads.view when a lead is inserted — by trigger, not by the
--      capture route, so a lead entered by hand or by any future path is
--      announced too; settle it for everyone when the lead is first worked
--      (leaves 'new'); and delete it when the lead is deleted (the
--      one-month purge), so the bell never links to a 404.
--
-- Recipient selection here and the client's can('leads.view') gate decide
-- one predicate in two languages; verify:leads asserts they agree.
-- ============================================================

-- ------------------------------------------------------------
-- REALTIME
-- ------------------------------------------------------------
alter publication supabase_realtime add table leads;

-- ------------------------------------------------------------
-- NOTIFICATIONS — arrival
-- ------------------------------------------------------------

create or replace function notify_lead_captured()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into notifications (staff_id, kind, title, body, link)
  select distinct s.id,
         'lead.captured',
         'New lead',
         new.first_name || ' ' || new.last_name || ' is interested'
           || case new.interest
                when 'membership' then ' in membership'
                when 'service'    then ' in a service'
                else ''
              end
           || ' (' || new.source || ')',
         '/leads/' || new.id
    from staff s
    join staff_roles sr on sr.staff_id = s.id
    join role_permissions rp on rp.role_id = sr.role_id
   where s.organization_id = new.organization_id
     and s.active
     and rp.permission_key = 'leads.view';
  return new;
end;
$$;

comment on function notify_lead_captured() is
  'AFTER INSERT on leads: one lead.captured notification per active staff member in the org holding leads.view, linking to /leads/<id>. By trigger rather than in the capture route, so a lead entered by hand is announced the same way. Recipients are chosen by permission, not role name.';

create trigger trg_notify_lead_captured
  after insert on leads
  for each row execute function notify_lead_captured();

-- ------------------------------------------------------------
-- NOTIFICATIONS — settle when first worked
-- ------------------------------------------------------------

-- The bell asks "has anyone picked this up?", and the answer is yes the
-- moment the lead leaves 'new' — contacted, qualified, lost or converted
-- alike. Settling marks EVERY recipient's copy read, not only the person
-- who acted: a colleague working a lead clears it from all bells. Read,
-- not deleted: the entry stays as history and its link still resolves.
create or replace function settle_lead_notifications()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'new' and new.status <> 'new' then
    update notifications
       set read_at = now()
     where kind = 'lead.captured'
       and link = '/leads/' || new.id
       and read_at is null;
  end if;
  return new;
end;
$$;

comment on function settle_lead_notifications() is
  'AFTER UPDATE OF status on leads: when a lead leaves new (contacted, qualified, lost or converted), every unread lead.captured notification for it is marked read — someone has picked it up, for everyone''s bell.';

create trigger trg_settle_lead_notifications
  after update of status on leads
  for each row execute function settle_lead_notifications();

-- ------------------------------------------------------------
-- NOTIFICATIONS — forget when the lead goes
-- ------------------------------------------------------------

create or replace function forget_lead_notifications()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  delete from notifications
   where kind = 'lead.captured'
     and link = '/leads/' || old.id;
  return old;
end;
$$;

create trigger trg_forget_lead_notifications
  after delete on leads
  for each row execute function forget_lead_notifications();
