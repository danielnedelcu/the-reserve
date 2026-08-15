-- ============================================================
-- Migration: staff self-service settings
-- npx supabase migration new staff_settings
--
-- 1) Personal columns on staff (mirroring the client expansion)
-- 2) Avatars storage bucket + per-user policies
-- 3) Staff can update their OWN row, but a trigger guard keeps
--    org-controlled columns off-limits without staff.edit
-- ============================================================

alter table staff
  add column avatar_url              text,
  add column phone                   text,
  add column pronouns                text,
  add column address_line1           text,
  add column address_line2           text,
  add column city                    text,
  add column state                   text,
  add column postal_code             text,
  add column emergency_contact_name  text,
  add column emergency_contact_phone text;

-- ------------------------------------------------------------
-- Self-update policy + protected-column guard
-- ------------------------------------------------------------

create policy staff_self_update on staff
  for update using (user_id = auth.uid());

-- RLS says WHO may update; this trigger says WHICH columns.
-- Org-controlled fields require staff.edit even on your own row.
create or replace function guard_staff_self_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.user_id = auth.uid() and not has_permission('staff.edit') then
    if new.email is distinct from old.email
       or new.title is distinct from old.title
       or new.bookable is distinct from old.bookable
       or new.active is distinct from old.active
       or new.organization_id is distinct from old.organization_id
       or new.user_id is distinct from old.user_id then
      raise exception 'These fields are managed by an administrator';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_guard_staff_self_update
  before update on staff
  for each row execute function guard_staff_self_update();

-- ------------------------------------------------------------
-- Avatars bucket (public read; each user writes only their own
-- folder, keyed by auth uid)
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatars_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_update_own" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_delete_own" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );