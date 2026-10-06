-- ============================================================
-- Migration: explicit API grants — the schema describes its own privileges
-- npx supabase migration new explicit_api_grants
--
-- Until now no migration granted anon, authenticated or service_role
-- anything on a table. The hosted project worked because it is a legacy
-- project whose default privileges handed every new table to the three
-- API roles; a stack rebuilt from the migrations alone gave them only
-- TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, and nothing could be read
-- (found 2026-10-05 building the CI database job). This states the
-- grants, so a new hosted project — staging, production — works from
-- the migrations alone, and the CI stack no longer needs the CLI's
-- deprecated auto_expose_new_tables switch.
--
-- The grants decide whether a role may ATTEMPT an operation; row-level
-- security, enabled on all 49 tables, decides which rows. One exception
-- is why the API roles get LESS here than hosted had: TRUNCATE bypasses
-- RLS, so anon and authenticated never hold it (the board's long-standing
-- TRUNCATE item, closed here); REFERENCES and TRIGGER go with it as
-- things no API caller needs. service_role keeps everything.
--
-- Hosted today differs from the end state of this file in exactly that:
-- TRUNCATE, REFERENCES and TRIGGER come off the two API roles on every
-- table. Everything else is what hosted already has.
-- ============================================================

-- ------------------------------------------------------------
-- TABLES
-- ------------------------------------------------------------

grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;

-- TRUNCATE is not subject to RLS; a role that can truncate can empty a
-- table it cannot read a row of. REFERENCES and TRIGGER are DDL-time
-- privileges with no API path.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- APPEND-ONLY TABLES — the revokes restated
-- Each of these tables' own migration already revokes what must never
-- be possible from a session. Restated AFTER the broad grants above so
-- the final state of every table is explicit here and does not depend
-- on which file ran last.
-- ------------------------------------------------------------

revoke update, delete         on audit_log            from anon, authenticated;
revoke update, delete         on form_versions        from anon, authenticated;
revoke insert, update, delete on communications_sent  from anon, authenticated;
revoke insert, delete         on campaign_recipients  from anon, authenticated;

-- ------------------------------------------------------------
-- SEQUENCES
-- The identity columns on audit_log and form_submission_attempts: an
-- insert needs USAGE on the sequence. usage, select, update is what
-- hosted holds and what Supabase grants by default; update (setval) is
-- harmless and keeping it makes the two sides identical.
-- ------------------------------------------------------------

grant usage, select, update on all sequences in schema public to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- FUNCTIONS
-- Seven security-definer functions revoke EXECUTE from public, anon and
-- authenticated in their own migrations; on hosted the service role kept
-- EXECUTE only because the legacy defaults had granted it at creation.
-- Stated here, because the service role is their only caller.
-- ------------------------------------------------------------

grant execute on function submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb) to service_role;
grant execute on function system_staff_id(uuid)                                            to service_role;
grant execute on function accept_staff_invite(uuid, uuid, text, text)                      to service_role;
grant execute on function run_communication_job(text)                                      to service_role;
grant execute on function purge_form_submission_attempts()                                 to service_role;
grant execute on function purge_leads()                                                    to service_role;
grant execute on function purge_prospect_intake()                                          to service_role;

-- get_my_permissions (schema_drift migration): read on every session.
grant execute on function get_my_permissions() to authenticated, service_role;

-- ------------------------------------------------------------
-- DEFAULT PRIVILEGES — so the next table does not repeat this
-- For objects the migrations create (as postgres) from now on: the same
-- shape as above. HOUSE RULE UNCHANGED, in both directions:
--   - a new append-only table still writes its own revoke in its own
--     migration; these defaults are the floor, not the policy;
--   - a new security-definer function that only the service role may
--     call still revokes EXECUTE from public, anon and authenticated in
--     its own migration — these defaults grant EXECUTE on new functions
--     to the three API roles, and Postgres grants it to PUBLIC regardless.
-- ------------------------------------------------------------

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select, update on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
