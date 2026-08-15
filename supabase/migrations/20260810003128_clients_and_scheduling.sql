-- ============================================================
-- Migration 3: Clients + Scheduling Core
-- clients, client_notes (tiered sensitivity), availability_rules,
-- availability_exceptions, appointments (+ exclusion constraints),
-- appointment_services (snapshots).
-- Create via: npx supabase migration new clients_and_scheduling
--   paste this content in, then: npm run db:push
-- ============================================================

-- Required for exclusion constraints combining = and && operators
create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- CLIENTS
-- ------------------------------------------------------------

create table clients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  first_name      text not null,
  last_name       text not null,
  email           text,
  phone           text,
  date_of_birth   date,
  referral_source text,
  no_show_count   int not null default 0,
  flags           jsonb not null default '{}'::jsonb,  -- {"requires_card_on_file": true}
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index clients_org_name on clients (organization_id, last_name, first_name);
create index clients_org_email on clients (organization_id, lower(email));

create trigger trg_clients_touch
  before update on clients
  for each row execute function touch_updated_at();

-- Tiered notes: health notes carry the tightest access in the system.
create table client_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  author_id  uuid not null references staff(id),
  kind       text not null check (kind in ('preference','health','internal')),
  body       text not null,
  created_at timestamptz not null default now()
);

create index client_notes_client on client_notes (client_id, created_at desc);

-- ------------------------------------------------------------
-- STAFF AVAILABILITY (rules + exceptions; slots computed at runtime)
-- ------------------------------------------------------------

create table availability_rules (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  location_id uuid not null references locations(id),
  day_of_week int not null check (day_of_week between 0 and 6),  -- 0 = Sunday
  start_time  time not null,   -- local to the location's timezone (survives DST)
  end_time    time not null,
  valid_from  date not null default current_date,
  valid_until date,            -- null = indefinite
  created_at  timestamptz not null default now(),
  check (start_time < end_time)
);

create index availability_rules_staff on availability_rules (staff_id, day_of_week);

create table availability_exceptions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  kind       text not null check (kind in ('time_off','sick','break','extra_shift')),
  -- 'extra_shift' ADDS availability; the others REMOVE it
  status     text not null default 'approved'
             check (status in ('requested','approved','denied')),
  note       text,
  created_by uuid not null references staff(id),
  created_at timestamptz not null default now(),
  check (starts_at < ends_at)
);

create index availability_exceptions_staff on availability_exceptions (staff_id, starts_at);

-- ------------------------------------------------------------
-- APPOINTMENTS
-- ------------------------------------------------------------

create table appointments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  location_id     uuid not null references locations(id),
  client_id       uuid not null references clients(id),
  staff_id        uuid not null references staff(id),
  resource_id     uuid references resources(id),  -- assigned room (nullable: some services may need none)

  -- Full blocked window INCLUDING buffers — what conflict checks use
  blocked_from    timestamptz not null,
  blocked_until   timestamptz not null,
  -- Client-facing service window
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,

  status          text not null default 'booked' check (status in
                  ('booked','confirmed','checked_in','in_progress',
                   'completed','cancelled','no_show')),
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    uuid references staff(id),

  booked_by       uuid not null references staff(id),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check (starts_at < ends_at),
  check (blocked_from <= starts_at and ends_at <= blocked_until)
);

create index appointments_calendar on appointments (location_id, blocked_from);
create index appointments_staff_day on appointments (staff_id, blocked_from);
create index appointments_client on appointments (client_id, starts_at desc);

create trigger trg_appointments_touch
  before update on appointments
  for each row execute function touch_updated_at();

-- THE conflict guarantees: double-booking a therapist or a room is
-- impossible at the database level, even under concurrent inserts.
alter table appointments add constraint no_staff_double_booking
  exclude using gist (
    staff_id with =,
    tstzrange(blocked_from, blocked_until) with &&
  ) where (status not in ('cancelled','no_show'));

alter table appointments add constraint no_room_double_booking
  exclude using gist (
    resource_id with =,
    tstzrange(blocked_from, blocked_until) with &&
  ) where (status not in ('cancelled','no_show') and resource_id is not null);

-- Line items: multi-service appointments + price/name/duration SNAPSHOTS.
-- Catalog changes must never rewrite booked history.
create table appointment_services (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  service_id     uuid not null references services(id),
  name_snapshot  text not null,
  price_cents    int not null,
  duration_min   int not null,
  sort_order     int not null default 0
);

create index appointment_services_appt on appointment_services (appointment_id);

-- ------------------------------------------------------------
-- NO-SHOW COUNTER (denormalized onto clients for policy checks)
-- ------------------------------------------------------------

create or replace function maintain_no_show_count()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'no_show' and old.status <> 'no_show' then
    update clients set no_show_count = no_show_count + 1 where id = new.client_id;
  elsif old.status = 'no_show' and new.status <> 'no_show' then
    update clients set no_show_count = greatest(no_show_count - 1, 0) where id = new.client_id;
  end if;
  return new;
end;
$$;

create trigger trg_no_show_counter
  after update on appointments
  for each row execute function maintain_no_show_count();

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table clients                 enable row level security;
alter table client_notes            enable row level security;
alter table availability_rules      enable row level security;
alter table availability_exceptions enable row level security;
alter table appointments            enable row level security;
alter table appointment_services    enable row level security;

-- Clients: per the matrix
create policy clients_read on clients
  for select using (organization_id = current_org_id() and has_permission('clients.view'));
create policy clients_insert on clients
  for insert with check (organization_id = current_org_id() and has_permission('clients.create'));
create policy clients_update on clients
  for update using (organization_id = current_org_id() and has_permission('clients.edit'));
create policy clients_delete on clients
  for delete using (organization_id = current_org_id() and has_permission('clients.delete'));

-- Client notes: health notes require the dedicated permission (front desk never sees them)
create policy client_notes_read on client_notes
  for select using (
    has_permission('clients.view')
    and (kind <> 'health' or has_permission('clients.notes.health.view'))
    and exists (select 1 from clients c where c.id = client_id and c.organization_id = current_org_id())
  );
create policy client_notes_insert on client_notes
  for insert with check (
    author_id = current_staff_id()
    and (
      (kind = 'health' and has_permission('clients.notes.health.create'))
      or (kind <> 'health' and has_permission('clients.view'))
    )
    and exists (select 1 from clients c where c.id = client_id and c.organization_id = current_org_id())
  );
-- Notes are append-only from the app's perspective: no update/delete policies.

-- Availability rules: everyone can read the org's rules (slot computation needs them);
-- edits follow the own/any scopes.
create policy availability_rules_read on availability_rules
  for select using (
    exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );
create policy availability_rules_write on availability_rules
  for all using (
    exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
    and (
      has_permission('availability.edit.any')
      or (has_permission('availability.edit.own') and staff_id = current_staff_id())
    )
  );

-- Availability exceptions: staff request their own; approvers manage any.
create policy availability_exceptions_read on availability_exceptions
  for select using (
    exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
  );
create policy availability_exceptions_insert on availability_exceptions
  for insert with check (
    created_by = current_staff_id()
    and exists (select 1 from staff s where s.id = staff_id and s.organization_id = current_org_id())
    and (
      has_permission('availability.edit.any')
      or (staff_id = current_staff_id() and has_permission('timeoff.request'))
    )
  );
create policy availability_exceptions_update on availability_exceptions
  for update using (
    has_permission('timeoff.approve')
    or (staff_id = current_staff_id() and status = 'requested')
  );

-- Appointments: own/any scopes; never deleted (no delete policy)
create policy appointments_read on appointments
  for select using (
    organization_id = current_org_id()
    and (
      has_permission('appointments.view.any')
      or (has_permission('appointments.view.own') and staff_id = current_staff_id())
    )
  );
create policy appointments_insert on appointments
  for insert with check (
    organization_id = current_org_id()
    and has_permission('appointments.create')
    and booked_by = current_staff_id()
  );
create policy appointments_update on appointments
  for update using (
    organization_id = current_org_id()
    and (
      has_permission('appointments.edit.any')
      or (has_permission('appointments.edit.own') and staff_id = current_staff_id())
    )
  );

-- Line items follow their parent appointment's visibility
create policy appointment_services_read on appointment_services
  for select using (
    exists (select 1 from appointments a where a.id = appointment_id
            and a.organization_id = current_org_id()
            and (has_permission('appointments.view.any')
                 or (has_permission('appointments.view.own') and a.staff_id = current_staff_id())))
  );
create policy appointment_services_write on appointment_services
  for all using (
    exists (select 1 from appointments a where a.id = appointment_id
            and a.organization_id = current_org_id()
            and (has_permission('appointments.edit.any')
                 or (has_permission('appointments.edit.own') and a.staff_id = current_staff_id())))
  );