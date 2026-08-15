-- ============================================================
-- Migration: expand client records
-- npx supabase migration new client_details
-- (clients already have: date_of_birth, referral_source, flags)
-- ============================================================

alter table clients
  add column pronouns                 text,
  add column address_line1            text,
  add column address_line2            text,
  add column city                     text,
  add column state                    text,
  add column postal_code              text,
  add column emergency_contact_name   text,
  add column emergency_contact_phone  text,
  add column preferred_contact_method text not null default 'email'
    check (preferred_contact_method in ('email','phone','sms')),
  add column marketing_opt_in         boolean not null default false,
  add column marketing_opt_in_at      timestamptz,
  add column preferred_staff_id       uuid references staff(id);

comment on column clients.flags is
  'Operational booleans, extendable without migrations. Known keys: requires_card_on_file';