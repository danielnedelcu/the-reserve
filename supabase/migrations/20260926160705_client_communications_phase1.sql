-- ============================================================
-- Migration: client communications — phase 1 (data model only)
-- npx supabase migration new client_communications_phase1
--
-- The lifecycle in docs/design/client-communications-design.md: seven
-- touchpoints from booking to post-visit, the cancel-via-link action, and
-- the cancellation-fee engine. This phase lands the FIELDS AND TABLES
-- only — preferences on clients, the token table the cancel link will
-- claim, and the sent-log that is both the double-send guard and the
-- audit trail — so preferences can be set on existing clients before
-- anything fires. No emails, no jobs, no cancel route yet (phases 2–4).
--
-- organization_id on both new tables is populated EXPLICITLY by their
-- service-role writers (the booking route from the service's org, the
-- cron jobs from the appointment/client row) — never current_org_id(),
-- which is null under the service role and inside pg_cron. Same rule the
-- lead capture endpoint and the form submit RPC already follow.
-- ============================================================

-- ------------------------------------------------------------
-- CLIENTS: communication preferences + the lifetime waiver
-- ------------------------------------------------------------

alter table clients
  add column communication_channel         text    not null default 'email'
    check (communication_channel in ('email', 'sms', 'both')),
  add column communication_opted_in        boolean not null default true,
  add column late_cancellation_waiver_used boolean not null default false;

comment on column clients.communication_channel is
  'HOW to reach the client: email | sms | both. text + check, not an enum type. SMS delivery is DEFERRED — every sender treats sms and both as email until the SMS phase lands (each delivery call carries a TODO) — but the preference is recorded from day one so no migration is needed then. Set by staff on the profile today; the public portal will read and write the same field.';
comment on column clients.communication_opted_in is
  'Covers NON-TRANSACTIONAL communications only (birthday, post-visit follow-up). Transactional ones — confirmation, day-before reminder, cancellation notice, intake reminder — fire regardless of this flag; a client cannot opt out of being told about their own appointment. Default true; settable by staff and, later, by the client.';
comment on column clients.late_cancellation_waiver_used is
  'One lifetime waiver per client. Set on first forgiven late cancellation; never reset. See client-communications-design.md. It is a RECORD, not a setting: staff can read it on the profile but there is no UI to clear it, and the fee engine (phase 4) is its only writer. Not consumed when the fee could not be charged for lack of a card on file — the client did not receive the benefit.';

-- ------------------------------------------------------------
-- CANCELLATION TOKENS
-- ------------------------------------------------------------

create table cancellation_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  appointment_id  uuid not null references appointments(id) on delete cascade,

  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

comment on table cancellation_tokens is
  'Single-use tokens for the public cancel-via-link flow. Created at booking, claimed atomically at cancellation. See client-communications-design.md. One per appointment: the confirmation and reminder emails carry /cancel/<id>; expires_at is the appointment start (no cancelling via link once it has begun); used_at is set by the cancel route in the same statement that checks it is null, so two clicks cannot both succeed. Same token-gated shape as the public intake submit: anon holds no policy here, staff never browse tokens, and the route reads and writes under the service role — NO authenticated policies exist, and that absence is the design. Cascades with its appointment.';

comment on column cancellation_tokens.expires_at is
  'The appointment''s starts_at at creation time. Past this, the link is dead even if unused.';

create index cancellation_tokens_appointment on cancellation_tokens (appointment_id);

-- ------------------------------------------------------------
-- COMMUNICATIONS SENT — the dedup guard and the audit trail
-- ------------------------------------------------------------

create table communications_sent (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  client_id       uuid not null references clients(id),
  appointment_id  uuid references appointments(id) on delete set null,

  kind            text not null
    check (kind in ('confirmation', 'day_before_reminder', 'intake_reminder',
                    'cancellation_notice', 'post_visit_followup', 'birthday')),
  channel         text not null check (channel in ('email', 'sms')),
  sent_at         timestamptz not null default now(),
  metadata        jsonb
);

comment on table communications_sent is
  'Append-only log of every communication sent. Checked before sending (dedup guard) and queryable as an audit trail. kind is the communication type; metadata carries template-specific context (service name, appointment time, etc.). Written only by the sending jobs and routes under the service role; staff holding clients.view read it for the profile''s communication history (phase 5). No authenticated insert/update/delete policies exist and none will: a row here means a message left the building, and that fact is never edited. channel records what was actually used (email | sms), never the preference ''both''. appointment_id is nullable because birthday messages have no appointment, and it survives an appointment''s deletion as null so the history stays whole.';

comment on column communications_sent.kind is
  'confirmation | day_before_reminder | intake_reminder | cancellation_notice | post_visit_followup | birthday. text + check; adding a touchpoint is a constraint swap.';
comment on column communications_sent.metadata is
  'Template context at send time (service name, appointment time, waiver/fee outcome for a cancellation notice). Snapshot, not a reference: it says what the client was TOLD.';

-- The dedup check and the profile history: "has this client had a <kind>
-- recently" and "what did we last send this client".
create index communications_sent_client_kind_sent
  on communications_sent (client_id, kind, sent_at desc);
-- Appointment-scoped: "was the confirmation / reminder for THIS booking sent".
create index communications_sent_appointment
  on communications_sent (appointment_id);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Both tables are written under the service role only. Tokens have no
-- staff surface at all; the sent-log is readable by staff who can see the
-- client.
-- ------------------------------------------------------------

alter table cancellation_tokens enable row level security;
alter table communications_sent enable row level security;

-- cancellation_tokens: NO policies. The public cancel route (phase 4) and
-- the booking route (phase 2) use the service role; nothing authenticated
-- or anon can read or write a token. Deliberate — see the table comment.

create policy communications_sent_read on communications_sent
  for select using (organization_id = current_org_id() and has_permission('clients.view'));

-- Append-only: no insert/update/delete policies for authenticated — the
-- jobs and routes write under the service role. Stated explicitly as well
-- as by omission, the way audit_log does it.
revoke insert, update, delete on communications_sent from authenticated, anon;
