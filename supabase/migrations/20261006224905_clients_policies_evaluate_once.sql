-- ============================================================
-- Migration: clients policies evaluate their helpers once
-- npx supabase migration new clients_policies_evaluate_once
-- ============================================================
-- The server-tables benchmark (2026-10-06, 10,000 clients) measured every
-- clients_page case at ~240ms and a bare count(*) at 255ms: clients_read
-- calls current_org_id() and has_permission() PER ROW. Wrapped as scalar
-- subqueries they are evaluated once per statement — same truth value,
-- same rows — and the count is 0.7ms, the function 4ms. The documented
-- Supabase pattern; every other policy in the schema has the same cost
-- and is a board item (docs/TODO.md).
--
-- Clause for clause with the policies as they stand: clients_read,
-- clients_update and clients_delete carry only USING; clients_insert
-- carries only WITH CHECK. alter policy leaves an unnamed clause as it
-- was, so each statement names exactly the clause the policy has.
--
-- Delete behaviour: none; same predicates, same semantics.

alter policy clients_read on clients
  using (organization_id = (select current_org_id()) and (select has_permission('clients.view')));
alter policy clients_insert on clients
  with check (organization_id = (select current_org_id()) and (select has_permission('clients.create')));
alter policy clients_update on clients
  using (organization_id = (select current_org_id()) and (select has_permission('clients.edit')));
alter policy clients_delete on clients
  using (organization_id = (select current_org_id()) and (select has_permission('clients.delete')));
