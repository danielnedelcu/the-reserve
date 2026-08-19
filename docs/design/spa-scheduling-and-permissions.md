# Spa Platform — Scheduling Data Model & Permission Matrix

Postgres-flavored (Supabase-ready). Naming and structure assume row-level security (RLS) will enforce most access rules, with application-layer logic for booking conflicts.

---

## Part 1: Scheduling Core Data Model

### Design principles

1. **Appointments reference three constrained resources**: a staff member, a room (or other resource), and a time window. A booking is valid only if all three are free.
2. **Availability is modeled as rules + exceptions**, not as pre-generated slots. Slots are computed at query time. Pre-generating slots seems simpler but becomes a nightmare when someone changes their weekly hours.
3. **Never delete appointments — status-transition them.** Cancelled/no-show records feed analytics, no-show policies, and the audit trail.
4. **Snapshot pricing and duration onto the appointment** at booking time. If the service price changes next month, historical appointments must not change.

### Entity relationship overview

```
organizations
  └── locations (even if you have 1 today, model it)
        ├── rooms/resources
        ├── staff (via staff_locations)
        └── appointments

services ──< service_staff (who can perform it)
services ──< service_resources (what room type it needs)

staff ──< availability_rules (recurring weekly hours)
staff ──< availability_exceptions (time off, one-off changes)

appointments >── clients
appointments ──< appointment_services (line items)
```

### Schema

```sql
-- ============================================================
-- ORG STRUCTURE
-- ============================================================

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'America/Los_Angeles',
  created_at  timestamptz not null default now()
);

create table locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  timezone        text not null,          -- per-location; don't inherit blindly
  business_hours  jsonb,                  -- {"mon": [["09:00","20:00"]], ...}
  created_at      timestamptz not null default now()
);

-- ============================================================
-- SERVICE CATALOG
-- ============================================================

create table service_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,          -- Massage, Facials, Body Treatments
  sort_order      int not null default 0
);

create table services (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id),
  category_id        uuid references service_categories(id),
  name               text not null,       -- "90-min Hot Stone Massage"
  description        text,
  duration_minutes   int not null,        -- client-facing duration
  buffer_before_min  int not null default 0,   -- room prep
  buffer_after_min   int not null default 10,  -- cleanup/turnover
  price_cents        int not null,
  active             boolean not null default true,
  requires_intake    boolean not null default false, -- forces waiver check
  created_at         timestamptz not null default now()
);

-- Which room *types* a service needs (not specific rooms)
create table resource_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null           -- "Massage Room", "Facial Room", "Sauna"
);

create table service_resource_requirements (
  service_id       uuid not null references services(id),
  resource_type_id uuid not null references resource_types(id),
  primary key (service_id, resource_type_id)
);

create table resources (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references locations(id),
  resource_type_id uuid not null references resource_types(id),
  name             text not null,         -- "Room 3"
  active           boolean not null default true
);

-- ============================================================
-- STAFF & QUALIFICATIONS
-- ============================================================

create table staff (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  user_id         uuid not null unique,   -- FK to auth.users in Supabase
  display_name    text not null,
  title           text,                   -- "Licensed Massage Therapist"
  color           text,                   -- calendar display color
  bookable        boolean not null default true,  -- front desk staff = false
  active          boolean not null default true,
  hired_at        date,
  created_at      timestamptz not null default now()
);

create table staff_locations (
  staff_id    uuid not null references staff(id),
  location_id uuid not null references locations(id),
  primary key (staff_id, location_id)
);

-- Who is qualified/allowed to perform which service
create table service_staff (
  service_id uuid not null references services(id),
  staff_id   uuid not null references staff(id),
  -- optional per-staff overrides:
  duration_override_min int,              -- senior therapist is faster
  price_override_cents  int,              -- senior therapist charges more
  primary key (service_id, staff_id)
);

-- ============================================================
-- AVAILABILITY (rules + exceptions, slots computed at runtime)
-- ============================================================

create table availability_rules (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id),
  location_id uuid not null references locations(id),
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time  time not null,              -- local to location timezone
  end_time    time not null,
  valid_from  date not null default current_date,
  valid_until date,                       -- null = indefinite
  check (start_time < end_time)
);

create table availability_exceptions (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  kind        text not null check (kind in ('time_off','sick','extra_shift','break')),
  -- 'extra_shift' ADDS availability; others REMOVE it
  status      text not null default 'approved'
              check (status in ('requested','approved','denied')),
  note        text,
  created_by  uuid not null,              -- who entered it (audit)
  check (starts_at < ends_at)
);

-- ============================================================
-- CLIENTS (minimal — full profile lives in membership module)
-- ============================================================

create table clients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  first_name      text not null,
  last_name       text not null,
  email           text,
  phone           text,
  no_show_count   int not null default 0, -- denormalized for policy checks
  flags           jsonb,                  -- {"requires_card_on_file": true}
  created_at      timestamptz not null default now()
);

-- Sensitive notes get their OWN table so RLS can gate them separately
create table client_notes (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id),
  author_id   uuid not null references staff(id),
  kind        text not null check (kind in ('preference','health','internal')),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- APPOINTMENTS
-- ============================================================

create table appointments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  location_id     uuid not null references locations(id),
  client_id       uuid not null references clients(id),
  staff_id        uuid not null references staff(id),
  resource_id     uuid references resources(id),   -- the assigned room

  -- The full blocked window INCLUDING buffers (what conflict checks use)
  blocked_from    timestamptz not null,
  blocked_until   timestamptz not null,
  -- The client-facing service window
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,

  status          text not null default 'booked' check (status in
                  ('booked','confirmed','checked_in','in_progress',
                   'completed','cancelled','no_show')),
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    uuid,                   -- staff or client-initiated

  booked_by       uuid not null,          -- staff member who created it
  notes           text,                   -- appointment-level note
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check (starts_at < ends_at),
  check (blocked_from <= starts_at and ends_at <= blocked_until)
);

-- Line items: supports multi-service appointments ("massage + facial")
-- and snapshots price/duration at time of booking
create table appointment_services (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id),
  service_id     uuid not null references services(id),
  name_snapshot  text not null,
  price_cents    int not null,            -- snapshot, NOT a live FK lookup
  duration_min   int not null,            -- snapshot
  sort_order     int not null default 0
);

-- ============================================================
-- CONFLICT PREVENTION (the important part)
-- ============================================================

-- Postgres exclusion constraints make double-booking IMPOSSIBLE at the
-- database level, even under concurrent requests. This is the single
-- best reason to use Postgres/Supabase for this app.

create extension if not exists btree_gist;

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
```

### The booking flow (application layer)

```
1. Client + service(s) selected
2. Compute candidate slots:
   availability_rules for staff
   − availability_exceptions (time off, breaks)
   − existing appointments (blocked windows)
   ∩ rooms of the required resource_type that are free
   ∩ location business hours
3. User picks slot → INSERT appointment inside a transaction
4. If the exclusion constraint rejects it (someone else grabbed it),
   surface "slot just taken" and refresh — no locks needed
```

The exclusion constraints are your safety net: even if two front-desk employees book the same slot simultaneously, the database rejects the second insert. You never have to trust the UI's stale view of availability.

### Gotchas to design around

- **Timezones**: store everything in `timestamptz` (UTC), convert to location timezone only at display/slot-computation time. Availability *rules* use local `time` because "9am Tuesday" should survive DST transitions.
- **Rescheduling**: implement as update to the same appointment row (keeps history via audit log), not cancel + rebook — unless your cancellation-fee logic needs the distinction.
- **Recurring appointments** ("every other Tuesday"): add a `recurrence_group_id uuid` column later; materialize each occurrence as a real row rather than storing an RRULE and expanding at read time. Much simpler.
- **Walk-ins**: an appointment with `starts_at = now()`, status `checked_in`. Don't build a separate path.

---

## Part 2: Permission Matrix

### Design

Three tables, not role columns:

```sql
create table roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,          -- 'super_admin','admin','front_desk','provider'
  is_system       boolean not null default false  -- system roles can't be deleted
);

create table permissions (
  key         text primary key,           -- 'appointments.edit.any'
  description text not null
);

create table role_permissions (
  role_id        uuid not null references roles(id),
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key)
);

create table staff_roles (
  staff_id uuid not null references staff(id),
  role_id  uuid not null references roles(id),
  primary key (staff_id, role_id)
);
```

Application code checks `has_permission(user, 'appointments.edit.any')` — never `if (user.role === 'admin')`. Roles become editable data; new roles require zero code changes.

**Permission key convention:** `domain.action.scope` where scope is `own` | `any`. The own/any split is the pattern that saves you: a therapist can edit *their own* schedule but not others'.

### The matrix

| Permission key | Super Admin | Admin | Front Desk | Provider (therapist) |
|---|---|---|---|---|
| **Appointments** |
| `appointments.view.own` | ✅ | ✅ | ✅ | ✅ |
| `appointments.view.any` | ✅ | ✅ | ✅ | ✅ ¹ |
| `appointments.create` | ✅ | ✅ | ✅ | ✅ |
| `appointments.edit.own` | ✅ | ✅ | ✅ | ✅ |
| `appointments.edit.any` | ✅ | ✅ | ✅ | ❌ |
| `appointments.cancel.any` | ✅ | ✅ | ✅ | ❌ |
| `appointments.override_conflicts` | ✅ | ✅ | ❌ | ❌ |
| **Clients** |
| `clients.view` | ✅ | ✅ | ✅ | ✅ |
| `clients.create` | ✅ | ✅ | ✅ | ❌ |
| `clients.edit` | ✅ | ✅ | ✅ | ❌ |
| `clients.notes.health.view` | ✅ | ✅ | ❌ | ✅ ² |
| `clients.notes.health.create` | ✅ | ✅ | ❌ | ✅ |
| `clients.export` | ✅ | ✅ | ❌ | ❌ |
| `clients.delete` | ✅ | ❌ | ❌ | ❌ |
| **Schedule / availability** |
| `availability.edit.own` | ✅ | ✅ | ❌ | ✅ |
| `availability.edit.any` | ✅ | ✅ | ❌ | ❌ |
| `timeoff.request` | ✅ | ✅ | ✅ | ✅ |
| `timeoff.approve` | ✅ | ✅ | ❌ | ❌ |
| **Staff management** |
| `staff.view` | ✅ | ✅ | ✅ | ✅ |
| `staff.invite` | ✅ | ✅ | ❌ | ❌ |
| `staff.edit` | ✅ | ✅ | ❌ | ❌ |
| `staff.deactivate` | ✅ | ✅ | ❌ | ❌ |
| `roles.manage` | ✅ | ❌ | ❌ | ❌ |
| **Services & catalog** |
| `services.view` | ✅ | ✅ | ✅ | ✅ |
| `services.manage` | ✅ | ✅ | ❌ | ❌ |
| **Payments & memberships** |
| `payments.take` | ✅ | ✅ | ✅ | ❌ |
| `payments.refund` | ✅ | ✅ | ❌ | ❌ |
| `memberships.manage` | ✅ | ✅ | ✅ | ❌ |
| `memberships.comp` (free/discounted) | ✅ | ✅ | ❌ | ❌ |
| **Financials** |
| `financials.view_summary` | ✅ | ✅ | ❌ | ❌ |
| `financials.view_detail` | ✅ | ✅ | ❌ | ❌ |
| `financials.view_own_earnings` | ✅ | ✅ | ❌ | ✅ ³ |
| `financials.export` | ✅ | ❌ | ❌ | ❌ |
| **Marketing / forms** |
| `forms.manage` | ✅ | ✅ | ❌ | ❌ |
| `forms.send` | ✅ | ✅ | ❌ | ❌ |
| `forms.responses.view` | ✅ | ✅ | ❌ | ❌ |
| **Analytics** |
| `analytics.view.org` | ✅ | ✅ | ❌ | ❌ |
| `analytics.view.own` | ✅ | ✅ | ❌ | ✅ |
| **Messaging** |
| `messages.send` | ✅ | ✅ | ✅ | ✅ |
| `messages.broadcast` (org-wide) | ✅ | ✅ | ❌ | ❌ |
| **System** |
| `audit_log.view` | ✅ | ❌ | ❌ | ❌ |
| `org.settings.manage` | ✅ | ❌ | ❌ | ❌ |
| `billing.manage` (the org's own subscription) | ✅ | ❌ | ❌ | ❌ |

¹ Providers seeing the full org calendar matches your requirement #9. Some spas restrict providers to their own — since it's data-driven, the org can toggle it.
² Providers need health notes to safely perform services (contraindications). Front desk does not — this is your most sensitive data category, gate it tightly.
³ Their own commission/earnings only — never org-wide.

### Notes on implementation

- **Seed these four as `is_system` roles**; let super admins clone and customize. Don't let anyone delete or de-permission the last super admin (classic lockout bug — enforce with a trigger or app check).
- **Supabase RLS mapping**: write a `has_permission(perm text)` SQL function that joins `staff_roles → role_permissions` for `auth.uid()`, then use it in policies: `create policy ... using (has_permission('clients.view'))`. Mark it `stable` and it's cached per statement. The `own` scopes add a predicate like `staff_id = current_staff_id()`.
- **Two-person rule for refunds over a threshold** is worth considering later — a `payments.refund.large` permission held only by super admins.
- **Every permission check failure and every use of a sensitive permission** (refunds, exports, health-note views) should write to the audit log. That table is append-only: no update/delete policies at all.
