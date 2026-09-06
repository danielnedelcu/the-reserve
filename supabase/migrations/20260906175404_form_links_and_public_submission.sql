-- ============================================================
-- Migration: form links + public submission (§6 phase 2)
-- npx supabase migration new form_links_and_public_submission
--
-- The app's FIRST unauthenticated write, and it lands PHI-adjacent data.
-- Every write surface before this one was authenticated; this one is
-- reached by anyone holding a link. The safety boundary is therefore in
-- the database, not in the route:
--
--   * anon holds NO privilege on any table here — no insert policy, and
--     no execute grant on the function that writes. The route runs under
--     the service role. "A direct anon insert fails" is a property of the
--     grants, not an accident of routing.
--   * single-use is an ATOMIC CLAIM (conditional update inside the
--     writing function), not a check in the route. Read-then-insert is a
--     race two simultaneous submits both win.
--   * a link freezes its form_version_id at issue, so publishing a new
--     version cannot change the questions someone was asked, or the
--     sensitive flags their answers get split against.
--
-- Decisions 5-9 and their rationale:
-- docs/design/prospective-onboarding-design.md, "Delivery and public
-- submission — locked decisions (phase 2)".
-- ============================================================

-- ------------------------------------------------------------
-- FORM LINKS — issuance. One table, subject optional.
-- ------------------------------------------------------------

create table form_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  form_version_id uuid not null references form_versions(id) on delete restrict,
  client_id       uuid references clients(id) on delete cascade,
  token           uuid not null unique default gen_random_uuid(),
  delivery_email  text,
  issued_by       uuid not null references staff(id),
  expires_at      timestamptz not null default now() + interval '14 days',
  consumed_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

comment on table form_links is
  'A tokenized link to one form version. NO subject means a prospect link (the prospect_intake row is created when they submit, not now — issuing creates nothing, so an unanswered link leaves no phantom prospect in the review queue). client_id set means an existing client''s waiver. Single-use: consumed_at is claimed atomically by submit_form_response, never by the route.';
comment on column form_links.form_version_id is
  'FROZEN AT ISSUE. The link points at the exact version the recipient will answer, so publishing a new version between sending and submitting cannot change their questions or the sensitive flags their answers are split against.';
comment on column form_links.token is
  'The only authorization the public submission path has. Unguessable (gen_random_uuid), single-use, expiring. There is deliberately no RLS policy exposing this table to anon — token lookup happens in a server route under the service role, the staff_invites pattern.';
comment on column form_links.consumed_at is
  'Set by the atomic claim inside submit_form_response. A route-side check followed by an insert would be a race; this column moves in the same transaction as the response it authorises.';

create index form_links_org_recent on form_links (organization_id, created_at desc);
create index form_links_open on form_links (organization_id, expires_at)
  where consumed_at is null and revoked_at is null;

alter table form_links enable row level security;

create policy form_links_read on form_links
  for select using (
    organization_id = current_org_id() and has_permission('forms.send')
  );
create policy form_links_manage on form_links
  for all using (
    organization_id = current_org_id() and has_permission('forms.send')
  );

-- ------------------------------------------------------------
-- PROSPECT INTAKE — temporary custody, created AT SUBMIT
-- ------------------------------------------------------------

create table prospect_intake (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  first_name      text not null,
  last_name       text not null,
  email           text not null,
  phone           text,
  status          text not null default 'submitted'
                    check (status in ('submitted','under_review','approved','rejected')),
  submitted_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table prospect_intake is
  'A person who has submitted an intake form and is not yet a client. TEMPORARY CUSTODY: contact details live here in transit and are purged at 30 days if the prospect never enrols (phase 3 sweep). Deliberately NOT a clients row with status=prospect — clients are members in this business, and status-flagging would force every existing clients query and policy to start filtering. Mirrors staff_invites being separate from staff.';
comment on column prospect_intake.status is
  'submitted -> under_review -> approved. approved creates NOTHING usable: enrollment (tier + card on file) is the gate to clienthood and is owner-blocked on §3. Transitions and the review UI land in phase 3; this column exists so a submission has somewhere to start.';
comment on column prospect_intake.email is
  'Promoted from the submission''s reserved email field, not typed by staff — the person''s own answer is the source of truth for details that become their client record.';

create index prospect_intake_pending on prospect_intake (organization_id, submitted_at desc)
  where status in ('submitted','under_review');

create trigger trg_prospect_intake_touch
  before update on prospect_intake
  for each row execute function touch_updated_at();

alter table prospect_intake enable row level security;

create policy prospect_intake_read on prospect_intake
  for select using (
    organization_id = current_org_id() and has_permission('forms.responses.view')
  );
-- Read only, deliberately. No INSERT policy: prospects come into being
-- through the public submission route, under the service role. No UPDATE
-- policy YET: the status transitions belong to phase 3's review action,
-- and shipping the write ahead of the feature that needs it grants a
-- capability nothing exercises — which is also a capability nothing
-- tests. No DELETE policy: the 30-day purge runs as the service role.

-- ------------------------------------------------------------
-- FORM RESPONSES — widen the subject to prospects
-- ------------------------------------------------------------

alter table form_responses
  add column prospect_intake_id uuid references prospect_intake(id) on delete cascade,
  add column form_link_id       uuid references form_links(id) on delete set null;

-- Phase 1 shipped this as "client_id is not null", named so this
-- migration could find it. Now: exactly one subject, never both.
alter table form_responses drop constraint form_responses_subject;
alter table form_responses add constraint form_responses_subject
  check (num_nonnulls(client_id, prospect_intake_id) = 1);

comment on constraint form_responses_subject on form_responses is
  'Exactly one subject: a client (waiver) or a prospect (intake), never both and never neither.';
comment on column form_responses.prospect_intake_id is
  'The subject when the person had no client record. Cascades: purging a prospect takes their answers with them, which is what the 30-day retention promise means.';
comment on column form_responses.form_link_id is
  'Which issued link produced this response. Audit trail, not authorization — the link is consumed by then. Nulls on delete so a tidied link cannot orphan a response.';

create index form_responses_prospect on form_responses (prospect_intake_id, submitted_at desc)
  where prospect_intake_id is not null;

-- ------------------------------------------------------------
-- SUBMISSION ATTEMPTS — rate-limit state, in the database
-- ------------------------------------------------------------

create table form_submission_attempts (
  id              bigint generated always as identity primary key,
  organization_id uuid references organizations(id),
  token           uuid,
  ip_hash         text not null,
  outcome         text not null check (outcome in ('accepted','rejected')),
  created_at      timestamptz not null default now()
);

comment on table form_submission_attempts is
  'Rate-limit state for the public submission endpoint, IN THE DATABASE rather than process memory: in-memory counters stop limiting the moment there is a second instance, and a security control that fails green is worse than none. organization_id and token are nullable because an attempt with an unrecognised token belongs to no org and names no real link — recording it is the point.';
comment on column form_submission_attempts.ip_hash is
  'HMAC-SHA256 of the client IP under a server-only secret (FORM_IP_PEPPER), never a plain hash: the IPv4 space is 4 billion values, so an unsalted digest is precomputable and therefore plaintext-equivalent — unacceptable for visitor records on a health-intake page. The keyed hash keeps the only property rate limiting needs, that the same IP yields the same value inside this system, without being reversible by anyone who obtains the table. Rows are still purged by the 30-day sweep. If the secret is absent the submission route REFUSES to serve rather than falling back to a weaker hash: a security control that silently degrades is the failure mode this project names by convention.';

create index form_submission_attempts_token on form_submission_attempts (token, created_at desc)
  where token is not null;
create index form_submission_attempts_ip on form_submission_attempts (ip_hash, created_at desc);

alter table form_submission_attempts enable row level security;

create policy form_submission_attempts_read on form_submission_attempts
  for select using (
    organization_id = current_org_id() and has_permission('audit_log.view')
  );

-- No write policies at all: only the submission route writes here, under
-- the service role. Rows with a null organization_id (unrecognised token)
-- are invisible to every authenticated caller by construction.

-- ------------------------------------------------------------
-- THE WRITE PATH — one function, service-role only
-- ------------------------------------------------------------

create or replace function submit_form_response(
  p_token        uuid,
  p_answers      jsonb,
  p_health       jsonb,
  p_consent_text text,
  p_consented    boolean,
  p_contact      jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link        form_links%rowtype;
  v_prospect_id uuid;
  v_response_id uuid;
  v_item        jsonb;
begin
  -- THE ATOMIC CLAIM. This conditional update is what makes a token
  -- single-use: the row is claimed and the response written in one
  -- transaction, so two simultaneous submits cannot both pass. Expiry and
  -- revocation are part of the same predicate, not separate checks.
  update form_links
     set consumed_at = now()
   where token = p_token
     and consumed_at is null
     and revoked_at is null
     and expires_at > now()
  returning * into v_link;

  if not found then
    raise exception 'invalid_or_used_token'
      using errcode = '22023',
            hint = 'The link is expired, already used, or was revoked.';
  end if;

  -- A prospect comes into being when they ANSWER, never when a link is
  -- issued. Contact columns are promoted from the reserved field keys.
  if v_link.client_id is null then
    insert into prospect_intake (organization_id, first_name, last_name, email, phone)
    values (
      v_link.organization_id,
      p_contact ->> 'first_name',
      p_contact ->> 'last_name',
      p_contact ->> 'email',
      p_contact ->> 'phone'
    )
    returning id into v_prospect_id;
  end if;

  insert into form_responses (
    organization_id, form_version_id, form_link_id,
    client_id, prospect_intake_id,
    answers, consent_text, consented_at
  )
  values (
    v_link.organization_id, v_link.form_version_id, v_link.id,
    v_link.client_id, v_prospect_id,
    coalesce(p_answers, '{}'::jsonb),
    p_consent_text,
    case when p_consented then now() end
  )
  returning id into v_response_id;

  -- Sensitive answers land in their own gated rows. The SPLIT itself is
  -- decided by the route against the version's frozen flags; this loop
  -- only writes what it was handed, so a bug here cannot silently move a
  -- health answer into the ungated blob — it can only fail to store one.
  for v_item in
    select value from jsonb_array_elements(coalesce(p_health, '[]'::jsonb))
  loop
    insert into form_response_health (form_response_id, field_key, label, answer)
    values (
      v_response_id,
      v_item ->> 'field_key',
      v_item ->> 'label',
      v_item -> 'answer'
    );
  end loop;

  return v_response_id;
end;
$$;

comment on function submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb) is
  'The only write path for a public form submission. SERVICE ROLE ONLY (execute revoked from public, anon, authenticated below) — anon therefore holds no privilege anywhere on this path: no insert policy on the response tables, and no grant on this function. Claims the token atomically, creates the prospect on a prospect link, writes the response and its gated health rows, all in one transaction.';

revoke execute on function
  submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb)
  from public, anon, authenticated;
