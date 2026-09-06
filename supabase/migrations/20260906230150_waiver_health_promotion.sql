-- ============================================================
-- Migration: promote waiver health answers into client_notes
-- npx supabase migration new waiver_health_promotion
--
-- When an EXISTING CLIENT submits a form (a treatment waiver), any health
-- answers are also written as client_notes rows with kind='health'.
--
-- WHY TWO COPIES, DELIBERATELY:
--
--   form_response_health is the SUBMISSION RECORD — immutable, tied to the
--   exact form version answered, and part of what the person consented to.
--   It is the legal artifact.
--
--   client_notes is the OPERATIONAL copy — where a therapist actually
--   looks before a session, and the tier whose reads are AUDITED.
--
-- The audit is the deciding reason, not convenience. A SELECT cannot fire
-- a trigger, so reads of form_response_health cannot be logged; leaving
-- health data readable only there would create health data that is
-- readable-but-unaudited and break the invariant that every read of health
-- data is recorded. Promotion puts the operational copy behind the route
-- that already logs health_note.viewed.
--
-- This is the same source -> operational relationship the design defines
-- for a prospect at enrollment; it simply happens at submit here, because
-- the client record already exists.
--
-- APPEND, NEVER SUPERSEDE. One note per health answer per submission,
-- dated and version-stamped. A therapist reading "March: knee injury /
-- June: resolved" is better informed than one reading only the latest
-- state, and client_notes is append-only by design anyway.
-- ============================================================

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

comment on function submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb) is
  'The only write path for a public form submission. SERVICE ROLE ONLY (execute revoked from public, anon, authenticated) — anon holds no privilege anywhere on this path: no insert policy on the response tables, and no grant on this function. Claims the token atomically, creates the prospect on a prospect link, writes the response and its gated health rows, and — for an EXISTING CLIENT — also appends each health answer to client_notes(kind=health). The two copies are intentional: form_response_health is the immutable submission record, client_notes is the operational therapist-facing copy whose reads are audited (a SELECT cannot fire a trigger, so the submission table''s reads cannot be logged). Appends, never supersedes: a dated, version-stamped note per answer per submission.';

revoke execute on function
  submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb)
  from public, anon, authenticated;
