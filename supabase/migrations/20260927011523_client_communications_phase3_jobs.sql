-- ============================================================
-- Migration: client communications — phase 3 (the scheduled jobs' clock)
-- npx supabase migration new client_communications_phase3_jobs
--
-- Four nightly touchpoints (docs/design/client-communications-design.md):
-- day-before reminder, intake reminder, post-visit follow-up, birthday.
-- pg_cron is the CLOCK only. Each tick POSTs one line of JSON to the
-- app's job route, which does the work under the service role: select
-- the rows, consult communications_sent (the dedup guard), send with the
-- same mailer and templates the booking route uses, and log a row ONLY
-- when Resend accepts — the invariant phase 2 set, which a database-side
-- send could not keep (pg_net is fire-and-forget). Keeping the sends in
-- a route is also the architecture rule: external calls live in routes.
--
-- The route's address and its bearer secret come from Vault at run time
-- (names below), inserted by hand in the dashboard — never in this file.
-- Missing either: the tick errors visibly in cron.job_run_details and
-- nothing is sent; there is no fallback to guess. docs/deployment.md
-- lists both entries with the other fail-closed configuration.
-- ============================================================

-- ------------------------------------------------------------
-- HTTP FROM THE DATABASE — pg_net, for the ticks only
-- ------------------------------------------------------------

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- THE TICK
-- ------------------------------------------------------------

create or replace function run_communication_job(p_job text)
returns bigint
language plpgsql
security definer set search_path = public, extensions, vault
as $$
declare
  v_site   text;
  v_secret text;
begin
  select decrypted_secret into v_site
    from vault.decrypted_secrets where name = 'communications_site_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'communications_job_secret';
  if v_site is null or v_secret is null then
    raise exception 'communications job % not run: vault secrets communications_site_url / communications_job_secret missing', p_job;
  end if;

  return net.http_post(
    url     := v_site || '/api/jobs/communications',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('job', p_job),
    timeout_milliseconds := 120000
  );
end;
$$;

comment on function run_communication_job(text) is
  'One cron tick: POSTs {"job": <name>} to the app''s communications job route, which selects, dedups against communications_sent, sends, and logs only on acceptance. Returns the pg_net request id; the response is in net._http_response. Site URL and bearer secret are Vault entries, read here, never stored in SQL.';

revoke execute on function run_communication_job(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- SCHEDULE — nightly, after the retention purges (03:17 / 03:30 / 03:45)
-- Cron runs on the database clock (UTC); the route computes "tomorrow"
-- and "yesterday" in each location's own timezone.
-- ------------------------------------------------------------

select cron.schedule('communications-day-before-reminder', '0 4 * * *',
  $$select run_communication_job('day_before_reminder')$$);
select cron.schedule('communications-intake-reminder',     '5 4 * * *',
  $$select run_communication_job('intake_reminder')$$);
select cron.schedule('communications-post-visit-followup', '10 4 * * *',
  $$select run_communication_job('post_visit_followup')$$);
select cron.schedule('communications-birthday',            '15 4 * * *',
  $$select run_communication_job('birthday')$$);
