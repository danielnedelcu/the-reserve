-- ============================================================
-- Migration: lead conversion — the provenance thread, end to end
-- npx supabase migration new leads_conversion
--
-- Phase 4 of §8 (docs/design/leads-design.md). Converting a lead means
-- SENDING THEM THE INTAKE FORM — the §6 form-send flow triggered from a
-- lead record — and it has to do three things as one:
--   1. issue a form_link for the intake form,
--   2. flip the lead to converted,
--   3. make sure the prospect that eventually answers points back at
--      the lead (prospect_intake.lead_id, added in phase 1).
--
-- The subtlety is WHEN. The lead converts when the link is issued, but
-- a prospect_intake row does not exist until the person submits (that
-- is how §6 works — a prospect comes into being when they answer). So
-- the lead's id has to travel FROM the lead, THROUGH the link, TO the
-- prospect: form_links gains a nullable lead_id, and submit_form_response
-- — the only place a prospect row is created — copies it across. The
-- chain is then whole the moment the person answers, and needs nothing
-- from anyone at that moment.
--
-- convert_lead() does steps 1 and 2 in ONE transaction, under the
-- CALLER's row-level security: a lead flipped with no link would be a
-- lead nobody can complete, a link with the lead still 'new' would lose
-- the provenance, so neither half may happen without the other.
-- ============================================================

-- ------------------------------------------------------------
-- FORM LINKS carry the lead they were issued for
-- ------------------------------------------------------------

alter table form_links
  add column lead_id uuid references leads(id) on delete set null;

-- A link is issued for a client OR for a lead, never both: a lead is by
-- definition not yet a client. Both null is the ordinary prospect link.
alter table form_links
  add constraint form_links_subject_not_both
  check (client_id is null or lead_id is null);

comment on column form_links.lead_id is
  'The lead this link was issued for by conversion (convert_lead). Read by submit_form_response and copied onto the prospect_intake row it creates — the provenance thread leads → prospect_intake → clients. Null for links issued any other way; never set together with client_id. on delete set null: a lead removed by hand ends the chain here rather than voiding the link.';

create index form_links_lead on form_links (lead_id) where lead_id is not null;

-- ------------------------------------------------------------
-- SUBMIT copies the lead onto the prospect it creates
-- Re-issued in full; the only change is the prospect insert (marked).
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
  v_form_name   text;
  v_version     int;
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
  --
  -- PROVENANCE (§8 phase 4): a link issued by converting a lead carries
  -- that lead's id, and it is copied onto the prospect HERE — the only
  -- place a prospect row is created. This is the middle link of
  -- leads → prospect_intake → clients; the lead itself was flipped to
  -- converted when the link was issued (convert_lead), so the chain is
  -- whole the moment the person answers. null for every other link.
  if v_link.client_id is null then
    insert into prospect_intake (organization_id, first_name, last_name, email, phone, lead_id)
    values (
      v_link.organization_id,
      p_contact ->> 'first_name',
      p_contact ->> 'last_name',
      p_contact ->> 'email',
      p_contact ->> 'phone',
      v_link.lead_id
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

  -- ── PROMOTION ────────────────────────────────────────────────────
  -- Only for an existing client. A prospect has no client record yet;
  -- theirs is promoted at enrollment (§3), which is where their client
  -- row comes into being.
  if v_link.client_id is not null then
    select d.name, fv.version into v_form_name, v_version
      from form_versions fv
      join form_definitions d on d.id = fv.form_definition_id
     where fv.id = v_link.form_version_id;

    for v_item in
      select value from jsonb_array_elements(coalesce(p_health, '[]'::jsonb))
    loop
      insert into client_notes (client_id, author_id, kind, body)
      values (
        v_link.client_id,
        -- The staff member who sent the form. A public submission has no
        -- staff session, and client_notes.author_id is NOT NULL — this
        -- records who put the question to them, which is the honest answer
        -- to "where did this note come from".
        v_link.issued_by,
        'health',
        format(
          '%s (%s v%s): %s — %s',
          to_char(now(), 'YYYY-MM-DD'),
          v_form_name,
          v_version,
          v_item ->> 'label',
          -- Render the answer as a person would read it. An array is every
          -- choice joined, NOT its first element — a multi-choice health
          -- answer that quietly kept only "neck" and dropped "lower back"
          -- would be worse than no note at all. #>> '{}' unquotes a scalar
          -- (text, boolean) without touching its meaning.
          case jsonb_typeof(v_item -> 'answer')
            when 'array' then (
              select string_agg(choice #>> '{}', ', ')
                from jsonb_array_elements(v_item -> 'answer') as choice
            )
            else v_item -> 'answer' #>> '{}'
          end
        )
      );
    end loop;
  end if;

  return v_response_id;
end;
$$;

-- ------------------------------------------------------------
-- CONVERT — flip the lead and issue its link, atomically
-- ------------------------------------------------------------

-- SECURITY INVOKER on purpose (the house default for helpers is definer;
-- this is not a helper). The caller's own policies authorise each half:
-- the leads update needs leads.manage in the caller's org, the form_links
-- insert needs forms.send in the caller's org. If either policy refuses,
-- its statement affects no row or raises, the function raises, and the
-- whole transaction — including the other half — rolls back. There is no
-- privilege here for anyone to borrow.
create or replace function convert_lead(
  p_lead_id         uuid,
  p_form_version_id uuid,
  p_delivery_email  text,
  p_expires_at      timestamptz
)
returns form_links
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_staff   uuid := current_staff_id();
  v_org     uuid := current_org_id();
  v_flipped uuid;
  v_link    form_links%rowtype;
begin
  if v_staff is null or v_org is null then
    raise exception 'Not a staff member';
  end if;

  -- The flip, first and conditionally: an already-converted lead is left
  -- alone (its conversion owns it), and a lead outside the caller's org or
  -- beyond their leads.manage is invisible to this UPDATE under RLS. Both
  -- read as "no row", and the caller distinguishes them with its own
  -- SELECT before calling. The trigger settle_lead_notifications fires
  -- from this update — leaving 'new' clears the arrival alert.
  update leads
     set status = 'converted'
   where id = p_lead_id
     and status <> 'converted'
  returning id into strict v_flipped;   -- 0 rows => no_data_found, caught below

  -- The link, carrying the lead. Subject-less (client_id null) so submit
  -- creates a prospect, and lead_id so that prospect points back here.
  insert into form_links (
    organization_id, form_version_id, client_id, lead_id,
    delivery_email, issued_by, expires_at
  )
  values (
    v_org, p_form_version_id, null, v_flipped,
    nullif(p_delivery_email, ''), v_staff, p_expires_at
  )
  returning * into v_link;

  return v_link;
exception
  when no_data_found then
    raise exception 'lead_not_convertible'
      using errcode = '22023',
            hint = 'The lead does not exist in your organisation, is already converted, or you cannot manage leads.';
end;
$$;

comment on function convert_lead(uuid, uuid, text, timestamptz) is
  'Converts a lead: flips it to converted and issues a subject-less intake form_link carrying lead_id, in one transaction under the caller''s RLS (leads.manage for the flip, forms.send for the link). Either half failing rolls back both. Raises lead_not_convertible when the lead is absent, out of scope, or already converted.';
