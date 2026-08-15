-- ============================================================
-- Migration 2: Service Catalog
-- Categories, services (durations + buffers + pricing), resource
-- types, rooms, staff qualifications, room requirements.
-- Create via: npx supabase migration new service_catalog
--   paste this content in, then: npm run db:push
-- ============================================================

-- ------------------------------------------------------------
-- CATEGORIES
-- ------------------------------------------------------------

create table service_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  unique (organization_id, name)
);

-- ------------------------------------------------------------
-- SERVICES
-- ------------------------------------------------------------

create table services (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  category_id        uuid references service_categories(id),
  name               text not null,
  description        text,
  duration_minutes   int not null check (duration_minutes > 0),
  buffer_before_min  int not null default 0 check (buffer_before_min >= 0),
  buffer_after_min   int not null default 10 check (buffer_after_min >= 0),
  price_cents        int not null check (price_cents >= 0),
  requires_intake    boolean not null default false,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index services_org_active on services (organization_id, active);

-- Keep updated_at honest on every change
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_services_touch
  before update on services
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------
-- RESOURCE TYPES & RESOURCES (rooms/equipment)
-- ------------------------------------------------------------

create table resource_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  unique (organization_id, name)
);

create table resources (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references locations(id),
  resource_type_id uuid not null references resource_types(id),
  name             text not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (location_id, name)
);

-- Which room TYPE a service needs (specific room assigned at booking)
create table service_resource_requirements (
  service_id       uuid not null references services(id) on delete cascade,
  resource_type_id uuid not null references resource_types(id) on delete cascade,
  primary key (service_id, resource_type_id)
);

-- ------------------------------------------------------------
-- STAFF QUALIFICATIONS
-- ------------------------------------------------------------

create table service_staff (
  service_id            uuid not null references services(id) on delete cascade,
  staff_id              uuid not null references staff(id) on delete cascade,
  duration_override_min int check (duration_override_min > 0),
  price_override_cents  int check (price_override_cents >= 0),
  created_at            timestamptz not null default now(),
  primary key (service_id, staff_id)
);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Reads: services.view (all roles). Writes: services.manage (admins).
-- ------------------------------------------------------------

alter table service_categories            enable row level security;
alter table services                      enable row level security;
alter table resource_types                enable row level security;
alter table resources                     enable row level security;
alter table service_resource_requirements enable row level security;
alter table service_staff                 enable row level security;

create policy categories_read on service_categories
  for select using (organization_id = current_org_id() and has_permission('services.view'));
create policy categories_manage on service_categories
  for all using (organization_id = current_org_id() and has_permission('services.manage'));

create policy services_read on services
  for select using (organization_id = current_org_id() and has_permission('services.view'));
create policy services_manage on services
  for all using (organization_id = current_org_id() and has_permission('services.manage'));

create policy resource_types_read on resource_types
  for select using (organization_id = current_org_id() and has_permission('services.view'));
create policy resource_types_manage on resource_types
  for all using (organization_id = current_org_id() and has_permission('services.manage'));

create policy resources_read on resources
  for select using (
    has_permission('services.view')
    and exists (select 1 from locations l where l.id = location_id and l.organization_id = current_org_id())
  );
create policy resources_manage on resources
  for all using (
    has_permission('services.manage')
    and exists (select 1 from locations l where l.id = location_id and l.organization_id = current_org_id())
  );

create policy srr_read on service_resource_requirements
  for select using (
    has_permission('services.view')
    and exists (select 1 from services s where s.id = service_id and s.organization_id = current_org_id())
  );
create policy srr_manage on service_resource_requirements
  for all using (
    has_permission('services.manage')
    and exists (select 1 from services s where s.id = service_id and s.organization_id = current_org_id())
  );

create policy service_staff_read on service_staff
  for select using (
    has_permission('services.view')
    and exists (select 1 from services s where s.id = service_id and s.organization_id = current_org_id())
  );
create policy service_staff_manage on service_staff
  for all using (
    has_permission('services.manage')
    and exists (select 1 from services s where s.id = service_id and s.organization_id = current_org_id())
  );

-- ------------------------------------------------------------
-- SEED: example catalog (marked EXAMPLE — replace via admin UI)
-- Assumes the single org from migration 1. Also creates the
-- org's first location, required by rooms.
-- ------------------------------------------------------------

do $$
declare
  org uuid;
  loc uuid;
  cat_massage uuid;
  cat_facial  uuid;
  cat_body    uuid;
  rt_massage  uuid;
  rt_facial   uuid;
  svc uuid;
begin
  select id into org from organizations limit 1;

  -- First location (idempotent-ish: only if none exists)
  select id into loc from locations where organization_id = org limit 1;
  if loc is null then
    insert into locations (organization_id, name, timezone)
    values (org, 'Main Location', 'America/Los_Angeles')
    returning id into loc;
  end if;

  -- Categories
  insert into service_categories (organization_id, name, sort_order)
    values (org, 'Massage', 0) returning id into cat_massage;
  insert into service_categories (organization_id, name, sort_order)
    values (org, 'Facials', 1) returning id into cat_facial;
  insert into service_categories (organization_id, name, sort_order)
    values (org, 'Body Treatments', 2) returning id into cat_body;

  -- Resource types
  insert into resource_types (organization_id, name)
    values (org, 'Massage Room') returning id into rt_massage;
  insert into resource_types (organization_id, name)
    values (org, 'Facial Room') returning id into rt_facial;

  -- Rooms
  insert into resources (location_id, resource_type_id, name) values
    (loc, rt_massage, 'Room 1'),
    (loc, rt_massage, 'Room 2'),
    (loc, rt_facial,  'Room 3');

  -- Services (EXAMPLE data)
  insert into services (organization_id, category_id, name, description,
                        duration_minutes, buffer_before_min, buffer_after_min,
                        price_cents, requires_intake)
  values (org, cat_massage, '[EXAMPLE] Swedish Massage — 60 min',
          'Classic full-body relaxation massage.', 60, 0, 15, 12000, true)
  returning id into svc;
  insert into service_resource_requirements values (svc, rt_massage);

  insert into services (organization_id, category_id, name, description,
                        duration_minutes, buffer_before_min, buffer_after_min,
                        price_cents, requires_intake)
  values (org, cat_massage, '[EXAMPLE] Deep Tissue Massage — 90 min',
          'Targeted deep pressure for chronic tension.', 90, 0, 15, 17500, true)
  returning id into svc;
  insert into service_resource_requirements values (svc, rt_massage);

  insert into services (organization_id, category_id, name, description,
                        duration_minutes, buffer_before_min, buffer_after_min,
                        price_cents, requires_intake)
  values (org, cat_facial, '[EXAMPLE] Signature Facial — 50 min',
          'Cleansing, exfoliation, and hydration tailored to skin type.',
          50, 5, 10, 9500, true)
  returning id into svc;
  insert into service_resource_requirements values (svc, rt_facial);

  insert into services (organization_id, category_id, name, description,
                        duration_minutes, buffer_before_min, buffer_after_min,
                        price_cents, requires_intake)
  values (org, cat_body, '[EXAMPLE] Herbal Body Wrap — 45 min',
          'Detoxifying wrap with warm herbal infusion.', 45, 10, 15, 11000, false)
  returning id into svc;
  insert into service_resource_requirements values (svc, rt_massage);
end $$;