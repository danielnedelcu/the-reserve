-- ============================================================
-- Migration: prospect review + retention (§6 phase 3)
-- npx supabase migration new prospect_review_and_retention
--
-- Finishes the front door through `approved`. Three things:
--
--   1. review columns and the UPDATE policy that the Approve action uses.
--      The policy lands WITH its action deliberately: phase 2 left it out
--      because a capability nothing exercises is also a capability nothing
--      tests.
--   2. two retention purges with two windows, because they serve two
--      purposes — 30 days for a person's submitted information, 24 hours
--      for rate-limit bookkeeping. Decision 10.
--   3. pg_cron to run them, so the schedule lives in the same place as the
--      data and cannot be silently absent the way an external scheduler
--      can.
--
-- APPROVAL CREATES NOTHING. It records a decision. Enrollment — tier,
-- card on file, the moment someone becomes a member — is §3 and
-- owner-blocked. There is deliberately no code path here that turns an
-- approved prospect into a client.
-- ============================================================

-- ------------------------------------------------------------
-- REVIEW — who decided, and when
-- ------------------------------------------------------------

alter table prospect_intake
  add column reviewed_by uuid references staff(id),
  add column reviewed_at timestamptz;

comment on column prospect_intake.reviewed_by is
  'The staff member who moved this prospect out of submitted. Set by the review route from current_staff_id(), never from the client.';
comment on column prospect_intake.reviewed_at is
  'When the decision was recorded. With reviewed_by this is the audit trail for an approval — approval creates nothing usable, so this row is the only evidence it happened.';

-- The write half of review, landing with the action that uses it.
-- WITH CHECK repeats the predicate so a row cannot be updated OUT of the
-- caller's organisation — USING alone would check the old row only.
create policy prospect_intake_update on prospect_intake
  for update
  using (organization_id = current_org_id() and has_permission('forms.responses.view'))
  with check (organization_id = current_org_id() and has_permission('forms.responses.view'));

-- ------------------------------------------------------------
-- RETENTION — two windows, two purposes
-- ------------------------------------------------------------

create or replace function purge_form_submission_attempts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  -- Rate-limit bookkeeping, not anyone's information. It only has to
  -- outlive the enforcement window it feeds (60 minutes), so a day is
  -- ~24 windows of headroom for reading an abuse pattern. Longer would
  -- retain hashed records of everyone who touched a health-intake form
  -- past every operational use they have.
  delete from form_submission_attempts
   where created_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function purge_form_submission_attempts() is
  'Deletes rate-limit telemetry older than 24 hours. Security telemetry is retained for exactly as long as the security function needs it — a different rule, and a different window, from the 30 days that applies to a person''s submitted information.';

create or replace function purge_prospect_intake()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  -- Deletes the PROSPECT; the response and its health rows follow by
  -- cascade. This is why the purge cannot over-delete: a client's waiver
  -- has prospect_intake_id null and is not reachable from here at all, so
  -- "never delete a legal record" is a property of the shape rather than
  -- of getting this predicate right. form_responses_subject (exactly one
  -- of client_id / prospect_intake_id) is what guarantees it.
  --
  -- The status list is an ALLOWLIST, never a NOT IN. When §3 adds
  -- 'enrolled', a paying member must not become purge-eligible by
  -- default: omission here means KEPT, which is the safe direction to
  -- fail in.
  delete from prospect_intake
   where status in ('submitted', 'under_review', 'approved', 'rejected')
     and submitted_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function purge_prospect_intake() is
  'Deletes prospects who never enrolled, 30 days after submission; their answers and health rows follow by cascade. Client waivers are unreachable from this statement by construction (they carry no prospect_intake_id), so the purge cannot destroy a legal record. Statuses are an allowlist so a future state added by §3 is kept, not purged.';

revoke execute on function purge_form_submission_attempts() from public, anon, authenticated;
revoke execute on function purge_prospect_intake() from public, anon, authenticated;

-- ------------------------------------------------------------
-- SCHEDULE — in the database, where the data is
-- ------------------------------------------------------------

-- An external nightly job that stops firing leaves data past its
-- retention window with nothing showing an error — a compliance control
-- that fails green. pg_cron keeps the schedule beside the data and the
-- rate-limit state, with no external moving part to assume.
--
-- This reduces the silent-failure surface; it does not remove it. A job
-- can be unscheduled or error every run and still look like a quiet
-- system, which is why verify:forms asserts the OUTCOME (no stale rows)
-- rather than the existence of a schedule.
create extension if not exists pg_cron;

select cron.schedule(
  'purge-form-submission-attempts',
  '17 * * * *',                       -- hourly, off the hour to avoid pile-ups
  $$select purge_form_submission_attempts()$$
);

select cron.schedule(
  'purge-prospect-intake',
  '30 3 * * *',                       -- nightly, well outside business hours
  $$select purge_prospect_intake()$$
);
