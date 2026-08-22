-- ============================================================
-- DRAFT — Migration: internal messaging (v1: DMs + ad-hoc groups)
-- Review together, then: npx supabase migration new messaging
-- ============================================================

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  kind            text not null check (kind in ('dm', 'group')),
  name            text,                          -- groups only
  created_by      uuid not null references staff(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table conversations is
  'DMs and ad-hoc group chats. updated_at is bumped by every message (list sort key). Append-only messaging: no edit/delete in v1.';

create table conversation_participants (
  conversation_id uuid not null references conversations(id) on delete cascade,
  staff_id        uuid not null references staff(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, staff_id)
);
comment on table conversation_participants is
  'Membership + read state. last_read_at is the unread mechanism: unread = messages newer than it. Rows are created only by the conversation functions (security definer).';

create index conversation_participants_staff on conversation_participants (staff_id);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_staff_id uuid not null references staff(id),
  body            text not null check (length(body) between 1 and 4000),
  created_at      timestamptz not null default now()
);
comment on table messages is
  'Append-only (no update/delete policies). Org-scoped through the parent conversation (transaction_items precedent). Published to realtime; RLS limits delivery to participants.';

create index messages_conversation on messages (conversation_id, created_at desc);

-- ------------------------------------------------------------
-- The recursion-safe membership check.
-- RLS policies on these tables cannot reference conversation_participants
-- directly without infinite recursion (42P17); SECURITY DEFINER bypasses RLS.
-- ------------------------------------------------------------
create or replace function is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql security definer set search_path = public
stable
as $$
  select exists (
    select 1 from conversation_participants
    where conversation_id = p_conversation_id
      and staff_id = current_staff_id()
  );
$$;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table conversations            enable row level security;
alter table conversation_participants enable row level security;
alter table messages                 enable row level security;

create policy conversations_read on conversations
  for select using (is_conversation_participant(id));

create policy participants_read on conversation_participants
  for select using (is_conversation_participant(conversation_id));

-- last_read_at updates: own row only
create policy participants_update_own on conversation_participants
  for update using (staff_id = current_staff_id());

-- No direct INSERT policies on conversations/participants for authenticated:
-- creation flows through the functions below (which also prevent adding
-- people to conversations you are not in).

create policy messages_read on messages
  for select using (is_conversation_participant(conversation_id));

create policy messages_send on messages
  for insert with check (
    sender_staff_id = current_staff_id()
    and is_conversation_participant(conversation_id)
  );
-- Append-only: no update/delete policies.

-- ------------------------------------------------------------
-- Functions
-- ------------------------------------------------------------

-- Canonical DM: the 'dm' conversation whose participant set is exactly {me, other}.
create or replace function find_or_create_dm(p_other_staff_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := current_staff_id();
  conv uuid;
begin
  if me is null then raise exception 'Not a staff member'; end if;
  if p_other_staff_id = me then raise exception 'Cannot DM yourself'; end if;

  -- other must be active staff in my org
  if not exists (
    select 1 from staff
    where id = p_other_staff_id and organization_id = current_org_id() and active
  ) then
    raise exception 'Staff member not found';
  end if;

  select c.id into conv
  from conversations c
  where c.kind = 'dm'
    and exists (select 1 from conversation_participants where conversation_id = c.id and staff_id = me)
    and exists (select 1 from conversation_participants where conversation_id = c.id and staff_id = p_other_staff_id)
    and (select count(*) from conversation_participants where conversation_id = c.id) = 2
  limit 1;

  if conv is not null then return conv; end if;

  insert into conversations (organization_id, kind, created_by)
  values (current_org_id(), 'dm', me)
  returning id into conv;

  insert into conversation_participants (conversation_id, staff_id)
  values (conv, me), (conv, p_other_staff_id);

  return conv;
end;
$$;

-- Ad-hoc group (creator auto-included, duplicates ignored)
create or replace function create_group_conversation(p_name text, p_staff_ids uuid[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := current_staff_id();
  conv uuid;
begin
  if me is null then raise exception 'Not a staff member'; end if;
  if coalesce(array_length(p_staff_ids, 1), 0) < 1 then
    raise exception 'Pick at least one person';
  end if;

  insert into conversations (organization_id, kind, name, created_by)
  values (current_org_id(), 'group', nullif(trim(p_name), ''), me)
  returning id into conv;

  insert into conversation_participants (conversation_id, staff_id)
  select conv, s.id
  from staff s
  where s.organization_id = current_org_id() and s.active
    and (s.id = me or s.id = any (p_staff_ids))
  on conflict do nothing;

  return conv;
end;
$$;

-- Mark read: bump last_read_at AND clear my unread bell notification for it
create or replace function mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := current_staff_id();
begin
  update conversation_participants
    set last_read_at = now()
    where conversation_id = p_conversation_id and staff_id = me;

  delete from notifications
    where staff_id = me
      and kind = 'message.received'
      and link = '/messages/' || p_conversation_id
      and read_at is null;
end;
$$;

-- ------------------------------------------------------------
-- Triggers
-- ------------------------------------------------------------

create or replace function message_bumps_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update conversations set updated_at = now() where id = new.conversation_id;
  return new;
end $$;

create trigger trg_message_bumps_conversation
  after insert on messages
  for each row execute function message_bumps_conversation();

-- Bell integration: notify other participants, at most one unread
-- notification per conversation per recipient (dedupe).
create or replace function notify_message_received()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  sender_name text;
begin
  select display_name into sender_name from staff where id = new.sender_staff_id;

  insert into notifications (staff_id, kind, title, body, link)
  select p.staff_id,
         'message.received',
         coalesce(sender_name, 'New message'),
         left(new.body, 80),
         '/messages/' || new.conversation_id
  from conversation_participants p
  where p.conversation_id = new.conversation_id
    and p.staff_id <> new.sender_staff_id
    and not exists (
      select 1 from notifications n
      where n.staff_id = p.staff_id
        and n.kind = 'message.received'
        and n.link = '/messages/' || new.conversation_id
        and n.read_at is null
    );
  return new;
end $$;

create trigger trg_notify_message_received
  after insert on messages
  for each row execute function notify_message_received();

-- ------------------------------------------------------------
-- Realtime: live threads + live conversation-list arrival
-- ------------------------------------------------------------
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversation_participants;