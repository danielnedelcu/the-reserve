-- ============================================================
-- Migration: form engine (§6) — definitions, immutable versions, responses
-- npx supabase migration new form_engine
--
-- The reusable core behind two callers: prospect onboarding (the
-- members-only front door) and existing-client waivers (the booking
-- route's requires_intake TODO). Neither caller ships here — this is the
-- engine they both sit on.
--
-- Decisions and their rationale: docs/design/prospective-onboarding-design.md,
-- "The form engine — locked schema decisions (phase 1)".
--
-- Two properties do the load-bearing work:
--   1. Health answers are separate ROWS behind clients.notes.health.view,
--      because RLS cannot hide a column. Missing data is loud; a leaked
--      column is silent.
--   2. Versions are immutable, so a response can reference the shape it
--      answered instead of copying it — while consent TEXT is copied,
--      because it is the legal artifact.
-- ============================================================

-- ------------------------------------------------------------
-- FORM DEFINITIONS — identity of a form, not its shape
-- ------------------------------------------------------------

create table form_definitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  key             text not null,
  name            text not null,
  description     text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, key)
);

comment on table form_definitions is
  'A form''s IDENTITY (org + key), separate from its answerable shape, which lives in versioned form_versions rows. One row per form the business asks people to fill: prospect_intake, service_waiver. Deactivated, never deleted — a definition with responses against it must stay resolvable forever.';
comment on column form_definitions.key is
  'Stable machine name the code refers to (prospect_intake, service_waiver). Never renamed: responses reach their definition through it, and a rename would silently re-point them.';

create trigger trg_form_definitions_touch
  before update on form_definitions
  for each row execute function touch_updated_at();

alter table form_definitions enable row level security;

create policy form_definitions_read on form_definitions
  for select using (
    organization_id = current_org_id()
    and (has_permission('forms.manage') or has_permission('forms.send')
         or has_permission('forms.responses.view'))
  );
create policy form_definitions_manage on form_definitions
  for all using (
    organization_id = current_org_id() and has_permission('forms.manage')
  );

-- ------------------------------------------------------------
-- FORM VERSIONS — the answerable shape. APPEND-ONLY.
-- ------------------------------------------------------------

create table form_versions (
  id                 uuid primary key default gen_random_uuid(),
  form_definition_id uuid not null references form_definitions(id) on delete restrict,
  version            int  not null check (version > 0),
  fields             jsonb not null,
  consent_text       text,
  published_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (form_definition_id, version)
);

comment on table form_versions is
  'One immutable published shape of a form. APPEND-ONLY BY DESIGN: no update or delete policy exists, so Postgres denies both, and the revoke below states that intent out loud. Editing a form means inserting a new version. That immutability is what lets a response REFERENCE the shape it answered instead of copying it — change a version in place and every response that points at it silently changes meaning.';
comment on column form_versions.fields is
  'Ordered array of field descriptors: [{"key","label","type","required","sensitive"}]. sensitive=true routes an answer to form_response_health instead of form_responses.answers — it is the switch that decides whether an answer needs clients.notes.health.view to read. Postgres cannot validate this shape; the server route that accepts submissions is the only enforcement, which is why it is the tested one.';
comment on column form_versions.consent_text is
  'The waiver/consent copy shown with THIS version. Copied onto each response at submit (form_responses.consent_text) — the reference here is provenance; the copy there is the legal record.';

-- Scoped through the parent definition (house pattern for child tables).
alter table form_versions enable row level security;

create policy form_versions_read on form_versions
  for select using (exists (
    select 1 from form_definitions d
     where d.id = form_definition_id
       and d.organization_id = current_org_id()
       and (has_permission('forms.manage') or has_permission('forms.send')
            or has_permission('forms.responses.view'))
  ));

create policy form_versions_insert on form_versions
  for insert with check (exists (
    select 1 from form_definitions d
     where d.id = form_definition_id
       and d.organization_id = current_org_id()
       and has_permission('forms.manage')
  ));

-- No update/delete policies above: versions are immutable once published.
-- Belt and braces, the audit_log idiom, so intent survives a future edit.
revoke update, delete on form_versions from authenticated, anon;

-- ------------------------------------------------------------
-- FORM RESPONSES — one submission. Non-sensitive answers only.
-- ------------------------------------------------------------

create table form_responses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  form_version_id uuid not null references form_versions(id) on delete restrict,
  client_id       uuid references clients(id) on delete cascade,
  answers         jsonb not null default '{}'::jsonb,
  consent_text    text,
  consented_at    timestamptz,
  submitted_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  constraint form_responses_subject check (client_id is not null)
);

comment on table form_responses is
  'One filled-in form. answers holds ONLY the non-sensitive answers; anything the version marks sensitive is in form_response_health, behind clients.notes.health.view. No authenticated INSERT policy exists on purpose: a submission must be validated against its version''s field list, Postgres cannot check jsonb shape, so writes go through a server route under the service role and the validator is the enforcement.';
comment on column form_responses.client_id is
  'The subject, when an existing client fills a waiver. Nullable because phase 2 adds prospect_intake_id for people who have no client record yet, and widens form_responses_subject to "exactly one subject". Until then the check requires a client.';
comment on column form_responses.consent_text is
  'Physical snapshot of the consent copy this person actually agreed to, readable without joining the version. Same discipline as the card-consent policy_text snapshot: the legal record must not depend on a lookup years later.';
comment on constraint form_responses_subject on form_responses is
  'Phase 1: the only subject is a client. Phase 2 drops and re-adds this as "exactly one of client_id / prospect_intake_id". Named so that migration can find it.';

create index form_responses_client on form_responses (client_id, submitted_at desc)
  where client_id is not null;
create index form_responses_version on form_responses (form_version_id);

alter table form_responses enable row level security;

create policy form_responses_read on form_responses
  for select using (
    organization_id = current_org_id() and has_permission('forms.responses.view')
  );

-- No insert/update/delete policies: see the table comment. Submissions are
-- written by a server route that validates shape; the retention purge (phase 3)
-- deletes under the service role, which bypasses RLS.

-- ------------------------------------------------------------
-- HEALTH ANSWERS — separate rows so RLS can gate them
-- ------------------------------------------------------------

create table form_response_health (
  id               uuid primary key default gen_random_uuid(),
  form_response_id uuid not null references form_responses(id) on delete cascade,
  field_key        text not null,
  label            text not null,
  answer           jsonb not null,
  created_at       timestamptz not null default now(),
  unique (form_response_id, field_key)
);

comment on table form_response_health is
  'Answers to fields the form version marks sensitive — health history and the like. A SEPARATE TABLE rather than a column on form_responses because RLS is row-level and cannot hide a column: as rows, the database itself refuses them to anyone without clients.notes.health.view, so a route that forgets to filter returns nothing rather than leaking PHI. Same tier as client_notes.kind=''health'', which is where these are promoted on enrollment.';
comment on column form_response_health.label is
  'The question as it was asked, snapshotted. An answer of "yes" is meaningless without the question, and the version''s field list can be superseded by a later publish.';

alter table form_response_health enable row level security;

create policy form_response_health_read on form_response_health
  for select using (exists (
    select 1 from form_responses r
     where r.id = form_response_id
       and r.organization_id = current_org_id()
       and has_permission('forms.responses.view')
       and has_permission('clients.notes.health.view')
  ));

-- No write policies: written by the same server route as the parent response.

-- ------------------------------------------------------------
-- PERMISSIONS — adopt migration 1's forms.* keys; mint nothing
-- ------------------------------------------------------------

-- These three were seeded in migration 1 as speculative "feedback forms"
-- keys and never referenced. The form engine adopts them rather than
-- minting an intake.* family for the same concept (the organization.manage
-- duplication cost a cleanup migration). Descriptions corrected to what
-- they now actually gate.
update permissions set description = 'Create and edit form definitions and publish new versions'
  where key = 'forms.manage';
update permissions set description = 'Send a form to a client or prospect (tokenized link)'
  where key = 'forms.send';
update permissions set description = 'View submitted form responses (non-health answers; health needs clients.notes.health.view)'
  where key = 'forms.responses.view';

-- Front desk needs all three: review and enrollment happen in person, at
-- the desk. Deliberately NOT granted clients.notes.health.view — that
-- absence is what makes the review screen structurally unable to show
-- health answers. super_admin holds every key already; admin holds all but
-- five, which do not include these.
insert into role_permissions (role_id, permission_key)
select r.id, k.key
  from roles r
  join (values ('forms.manage'), ('forms.send'), ('forms.responses.view')) as k(key)
    on true
 where r.name = 'front_desk';
