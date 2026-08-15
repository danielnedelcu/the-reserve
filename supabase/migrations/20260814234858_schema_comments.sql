-- ============================================================
-- Migration: schema comments (documentation backfill)
-- npx supabase migration new schema_comments
-- Comments live IN the database: they appear in the Supabase
-- dashboard, GUI tools, and the tbls-generated docs.
-- ============================================================

comment on table organizations is
  'Tenant root. Single row today; every domain table hangs off organization_id for future multi-tenancy.';

comment on table staff is
  'Employees. Linked 1:1 to auth.users via user_id. Deactivated (active=false), never deleted. Self-editable personal fields are guarded by trg_guard_staff_self_update.';
comment on column staff.bookable is
  'Whether this person appears as a provider in scheduling (columns, qualification pickers, slot search).';

comment on table roles is
  'Role definitions. system=true rows (super_admin, admin, front_desk, provider) cannot be deleted.';
comment on table permissions is
  'Permission catalog: domain.action(.own|.any) keys. Seeded in migration 1; code references keys as strings.';
comment on table role_permissions is
  'The permission matrix as data. Changing a row changes app behavior everywhere with zero deploys.';
comment on table staff_roles is
  'Role assignments. Audit-logged by trigger; last-super-admin removal blocked by trigger.';

comment on table staff_invites is
  'Tokenized invites (7-day expiry). Accepted atomically by accept_staff_invite() — service-role only. Partial unique index prevents duplicate pending invites per email.';

comment on table clients is
  'Spa clients (no auth accounts). no_show_count is maintained by trigger from appointment status changes. flags is an extensible jsonb for operational booleans (requires_card_on_file).';
comment on table client_notes is
  'Tiered notes: preference | internal | health. HEALTH notes are RLS-gated to clients.notes.health.view and must be read through the audited server route (reads cannot fire triggers, so auditing lives at the app layer). Append-only.';

comment on table service_categories is 'Menu grouping (Massage, Facials, ...).';
comment on table services is
  'The treatment catalog. duration_minutes is client-facing; buffers extend the blocked window. Prices in cents. requires_intake gates booking once intake forms exist. Deactivated, never deleted.';
comment on column services.buffer_after_min is
  'Cleanup/reset time appended to the blocked window; invisible to the client-facing times.';
comment on table service_staff is
  'Qualification: who may perform what, with optional per-staff duration/price overrides that the slot and booking routes apply.';
comment on table resource_types is 'Room categories services require (Massage Room, Facial Room, ...).';
comment on table resources is 'Concrete rooms per location. Inactive rooms leave bookable inventory immediately.';
comment on table service_resource_requirements is
  'Service -> room TYPE requirement; a concrete free room of the type is assigned at booking.';

comment on table availability_rules is
  'Recurring weekly hours in LOCATION-LOCAL time (survives DST). Overlaps per staff/day are impossible: no_overlapping_hours exclusion constraint (timerange custom type).';
comment on table availability_exceptions is
  'Time off / sick / breaks (remove availability) and extra shifts (add it). requested -> approved/denied workflow; decisions notify the subject and new requests notify approvers via triggers.';

comment on table appointments is
  'Never deleted — status lifecycle only (booked→confirmed→checked_in→in_progress→completed | cancelled | no_show). Double-booking of staff or rooms is impossible: gist exclusion constraints on the blocked window, which ignore cancelled/no_show rows so slots free themselves.';
comment on column appointments.blocked_from is
  'Start of the FULL blocked window including buffer_before — what all conflict checks use.';
comment on column appointments.starts_at is 'Client-facing start (inside the blocked window).';
comment on table appointment_services is
  'Line items with name/price/duration SNAPSHOTS taken at booking: catalog edits never rewrite booked history.';

comment on table notifications is
  'In-app notifications. Created ONLY by triggers/service role (no authenticated insert policy). RLS scopes reads and mark-read to the recipient — including over Realtime, which is published for this table.';

comment on table audit_log is
  'Append-only. Inserts via service role / security-definer functions only. Includes health_note.viewed (app-layer, since SELECTs cannot fire triggers), appointment.booked, staff lifecycle events.';