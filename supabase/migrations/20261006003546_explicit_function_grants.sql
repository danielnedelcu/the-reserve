-- ============================================================
-- Migration: explicit function grants — EXECUTE described by the schema
-- npx supabase migration new explicit_function_grants
--
-- The companion of explicit_api_grants for functions. On the hosted
-- project every function created before 2026-10-06 carries explicit
-- EXECUTE rows for anon, authenticated and service_role, written by the
-- legacy default privileges at creation; on a stack built from the
-- migrations the same functions have no ACL at all and are executable
-- only through Postgres's PUBLIC default. Identical in effect, different
-- on paper — and "identical in effect" is not something a comparison
-- can see. This states the grants, then restates every revoke the
-- migrations make, so the end state of every function is explicit here
-- and the two sides are the same on paper too. A no-op in effect on
-- both sides.
--
-- The revoke list below is DERIVED from the migrations' own
-- `revoke execute` statements (grep them), not from memory. A new
-- service-role-only function still revokes in its own migration (the
-- house rule stated in explicit_api_grants); it is added here only if
-- this file is ever re-run as a whole.
-- ============================================================

-- ------------------------------------------------------------
-- THE GRANT
-- ------------------------------------------------------------

grant execute on all functions in schema public to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- THE REVOKES RESTATED — after the grant, so order does not matter
-- Service-role-only (routes and pg_cron call these; no session may):
-- ------------------------------------------------------------

revoke execute on function accept_staff_invite(uuid, uuid, text, text)                      from public, anon, authenticated;
revoke execute on function submit_form_response(uuid, jsonb, jsonb, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function purge_form_submission_attempts()                                 from public, anon, authenticated;
revoke execute on function purge_prospect_intake()                                          from public, anon, authenticated;
revoke execute on function purge_leads()                                                    from public, anon, authenticated;
revoke execute on function run_communication_job(text)                                      from public, anon, authenticated;
revoke execute on function system_staff_id(uuid)                                            from public, anon, authenticated;

-- Not restated: ask_readonly_role's revoke on ask_execute_sql(text, int),
-- because ask_readonly_login_role dropped that function the same day
-- (the security fix replaced the execution RPC with a login role).
-- Every other revoke execute in the migrations is above.
