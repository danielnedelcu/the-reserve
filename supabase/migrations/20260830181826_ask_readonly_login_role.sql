-- ============================================================
-- Migration: Ask The Reserve — close the SET LOCAL ROLE escalation
-- npx supabase migration new ask_readonly_login_role
--
-- SECURITY FIX. The ask_readonly_role migration shipped an execution
-- RPC that switched roles inside the caller's session. That is broken:
-- under PostgREST the session user is `authenticator`, which holds
-- membership in anon, authenticated AND service_role — that membership
-- is how PostgREST switches roles at all. Role-change privilege is
-- checked against the SESSION user, so a generated statement containing
--
--   set_config('role','service_role',true)
--
-- escalates straight past the role switch, past the SELECT allowlist,
-- and past the deliberate client_notes (PHI) exclusion. As a function
-- call inside a SELECT it also satisfies the single-statement and
-- SELECT-prefix checks, so those provided no cover.
--
-- The fix is structural, not a patch to the checks: execution moves to
-- a connection whose SESSION USER is ask_readonly, so there is no
-- privileged role to climb back to. The standing rule this leaves
-- behind — execution runs on a session whose session_user is the leash;
-- never role-switch within a privileged session.
--
-- MANUAL STEP REQUIRED AFTER APPLYING (a password never belongs in a
-- migration file):
--
--   alter role ask_readonly with password '<generated>';
--
-- then put the full connection string in ASK_DATABASE_URL. Until that
-- password is set the role cannot authenticate (Supabase requires
-- scram), so a half-finished setup fails closed and /api/ask returns
-- a 503 rather than running anything.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Remove the escalation vector.
-- Dropping the function also removes the EXECUTE grant that let any
-- authenticated session with ask.query reach it over PostgREST RPC.
-- ------------------------------------------------------------
drop function ask_execute_sql(text, int);

-- ------------------------------------------------------------
-- 2. Remove the membership that made the role switch legal.
-- Nothing should be able to BECOME ask_readonly; things should only be
-- able to CONNECT as it.
-- ------------------------------------------------------------
revoke ask_readonly from authenticated;

-- ------------------------------------------------------------
-- 3. Make it a login role, and put the limits on the role itself so
-- every session gets them whether or not the route asks.
-- ------------------------------------------------------------
alter role ask_readonly with login connection limit 5;

alter role ask_readonly set default_transaction_read_only = on;
alter role ask_readonly set statement_timeout = '10s';
alter role ask_readonly set idle_in_transaction_session_timeout = '30s';

-- The SELECT allowlist and the helper-function grants from the previous
-- migration are unchanged and still correct — the role's privileges were
-- never the problem, only who could assume them.
--
-- Note on SECURITY DEFINER functions elsewhere in public: several are
-- executable by PUBLIC and run as their owner. They cannot be used to
-- write from an ask session — the connection is read-only at the role
-- level, and a read-only transaction refuses writes regardless of the
-- privileges a definer function holds.
