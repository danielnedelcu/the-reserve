-- Leave a conversation: remove my participant row, clear my bell entries
-- for it, and garbage-collect the conversation if I was the last one out.
create or replace function leave_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := current_staff_id();
  remaining int;
begin
  if me is null then raise exception 'Not a staff member'; end if;

  delete from conversation_participants
    where conversation_id = p_conversation_id and staff_id = me;

  delete from notifications
    where staff_id = me
      and kind = 'message.received'
      and link = '/messages/' || p_conversation_id;

  select count(*) into remaining
    from conversation_participants
    where conversation_id = p_conversation_id;

  if remaining = 0 then
    delete from conversations where id = p_conversation_id; -- cascades messages
  end if;
end;
$$;