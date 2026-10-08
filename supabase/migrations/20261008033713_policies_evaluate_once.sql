-- ============================================================
-- Migration: every policy evaluates its helpers once
-- npx supabase migration new policies_evaluate_once
-- ============================================================
-- docs/design/policy-sweep-design.md, PR 1. Every RLS policy called
-- current_org_id(), has_permission(), current_staff_id(), auth.uid() or
-- is_admin() PER ROW. Wrapped as scalar subqueries — (select …) — the
-- planner evaluates each once per statement: the same truth value, the
-- same rows (the helpers are STABLE), measured on clients at 255ms → 0.7ms
-- for a bare count over 10,000 rows (20261006224905, the model for this
-- file). This is that change for the 70 policies that still had the
-- per-row form: the 45 mechanical ones, and the helper calls inside 25
-- of the 27 structural ones (payments_read and transaction_items_read
-- were wrapped in server-tables PR 3; their parent `exists` lookup, like
-- the others', stays until the ledger lines carry their own
-- organization_id, PR 2).
--
-- Clause for clause with the policies as they stand on hosted
-- (pg_policies, 2026-10-08): alter policy leaves an unnamed clause as it
-- was, so each statement names exactly the clauses the policy has; an
-- ALL policy with only USING keeps its implied WITH CHECK, before and
-- after. No policy is dropped, renamed or re-scoped; no table gains or
-- loses one. The three conversation policies are not here: their
-- is_conversation_participant(conversation_id) takes the row's own
-- column and must stay correlated (participants_read cannot select from
-- its own table without recursing; the other two would read
-- conversation_participants under its own policy anyway). messages_send
-- keeps that call and gets its current_staff_id() wrapped. The guard,
-- scripts/verify-policies.mjs, allowlists exactly those three.
--
-- Delete behaviour: none; same predicates, same semantics.

-- appointment_services
alter policy appointment_services_read on appointment_services
  using ((exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = (select current_org_id())) and ((select has_permission('appointments.view.any')) or ((select has_permission('appointments.view.own')) and (a.staff_id = (select current_staff_id()))))))));
alter policy appointment_services_write on appointment_services
  using ((exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = (select current_org_id())) and ((select has_permission('appointments.edit.any')) or ((select has_permission('appointments.edit.own')) and (a.staff_id = (select current_staff_id()))))))));

-- appointments
alter policy appointments_insert on appointments
  with check (((organization_id = (select current_org_id())) and (select has_permission('appointments.create')) and (booked_by = (select current_staff_id()))));
alter policy appointments_read on appointments
  using (((organization_id = (select current_org_id())) and ((select has_permission('appointments.view.any')) or ((select has_permission('appointments.view.own')) and (staff_id = (select current_staff_id()))))));
alter policy appointments_update on appointments
  using (((organization_id = (select current_org_id())) and ((select has_permission('appointments.edit.any')) or ((select has_permission('appointments.edit.own')) and (staff_id = (select current_staff_id()))))));

-- ask_queries
alter policy ask_queries_read on ask_queries
  using (((organization_id = (select current_org_id())) and (select has_permission('ask.query'))));

-- audit_log
alter policy audit_read on audit_log
  using ((select has_permission('audit_log.view')));

-- availability_exceptions
alter policy availability_exceptions_insert on availability_exceptions
  with check (((created_by = (select current_staff_id())) and (exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = (select current_org_id()))))) and ((select has_permission('availability.edit.any')) or ((staff_id = (select current_staff_id())) and (select has_permission('timeoff.request'))))));
alter policy availability_exceptions_read on availability_exceptions
  using ((exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = (select current_org_id()))))));
alter policy availability_exceptions_update on availability_exceptions
  using (((select has_permission('timeoff.approve')) or ((staff_id = (select current_staff_id())) and (status = 'requested'))));

-- availability_rules
alter policy availability_rules_read on availability_rules
  using ((exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = (select current_org_id()))))));
alter policy availability_rules_write on availability_rules
  using (((exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = (select current_org_id()))))) and ((select has_permission('availability.edit.any')) or ((select has_permission('availability.edit.own')) and (staff_id = (select current_staff_id()))))));

-- campaign_recipients
alter policy campaign_recipients_read on campaign_recipients
  using (((organization_id = (select current_org_id())) and (select is_admin())));

-- campaigns
alter policy campaigns_manage on campaigns
  using (((organization_id = (select current_org_id())) and (select is_admin())));

-- card_consents
alter policy card_consents_read on card_consents
  using (((organization_id = (select current_org_id())) and (select has_permission('cards.view'))));

-- client_notes
alter policy client_notes_insert on client_notes
  with check (((author_id = (select current_staff_id())) and (((kind = 'health') and (select has_permission('clients.notes.health.create'))) or ((kind <> 'health') and (select has_permission('clients.view')))) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = (select current_org_id())))))));
alter policy client_notes_read on client_notes
  using (((select has_permission('clients.view')) and ((kind <> 'health') or (select has_permission('clients.notes.health.view'))) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = (select current_org_id())))))));

-- client_payment_methods
alter policy client_payment_methods_read on client_payment_methods
  using (((organization_id = (select current_org_id())) and (select has_permission('cards.view'))));

-- communications_sent
alter policy communications_sent_read on communications_sent
  using (((organization_id = (select current_org_id())) and (select has_permission('clients.view'))));

-- conversation_participants
alter policy participants_update_own on conversation_participants
  using ((staff_id = (select current_staff_id())));

-- form_definitions
alter policy form_definitions_manage on form_definitions
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.manage'))));
alter policy form_definitions_read on form_definitions
  using (((organization_id = (select current_org_id())) and ((select has_permission('forms.manage')) or (select has_permission('forms.send')) or (select has_permission('forms.responses.view')))));

-- form_links
alter policy form_links_manage on form_links
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.send'))));
alter policy form_links_read on form_links
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.send'))));

-- form_response_health
alter policy form_response_health_read on form_response_health
  using ((exists (select 1 from form_responses r where ((r.id = form_response_health.form_response_id) and (r.organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')) and (select has_permission('clients.notes.health.view'))))));

-- form_responses
alter policy form_responses_read on form_responses
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view'))));

-- form_submission_attempts
alter policy form_submission_attempts_read on form_submission_attempts
  using (((organization_id = (select current_org_id())) and (select has_permission('audit_log.view'))));

-- form_versions
alter policy form_versions_insert on form_versions
  with check ((exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = (select current_org_id())) and (select has_permission('forms.manage'))))));
alter policy form_versions_read on form_versions
  using ((exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = (select current_org_id())) and ((select has_permission('forms.manage')) or (select has_permission('forms.send')) or (select has_permission('forms.responses.view')))))));

-- lead_notes
alter policy lead_notes_insert on lead_notes
  with check (((staff_id = (select current_staff_id())) and (select has_permission('leads.manage')) and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = (select current_org_id())))))));
alter policy lead_notes_read on lead_notes
  using (((select has_permission('leads.view')) and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = (select current_org_id())))))));

-- leads
alter policy leads_manage on leads
  using (((organization_id = (select current_org_id())) and (select has_permission('leads.manage'))));
alter policy leads_read on leads
  using (((organization_id = (select current_org_id())) and (select has_permission('leads.view'))));

-- locations
alter policy locations_manage on locations
  using (((organization_id = (select current_org_id())) and (select has_permission('org.settings.manage'))));
alter policy locations_read on locations
  using ((organization_id = (select current_org_id())));

-- messages
alter policy messages_send on messages
  with check (((sender_staff_id = (select current_staff_id())) and is_conversation_participant(conversation_id)));

-- notifications
alter policy notifications_read on notifications
  using ((staff_id = (select current_staff_id())));
alter policy notifications_update on notifications
  using ((staff_id = (select current_staff_id())));

-- organizations
alter policy org_manage on organizations
  using (((id = (select current_org_id())) and (select has_permission('org.settings.manage'))));
alter policy org_read on organizations
  using ((id = (select current_org_id())));
alter policy organizations_settings_manage on organizations
  using (((id = (select current_org_id())) and (select has_permission('org.settings.manage'))));

-- prospect_intake
alter policy prospect_intake_read on prospect_intake
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view'))));
alter policy prospect_intake_update on prospect_intake
  using (((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view'))))
  with check (((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view'))));

-- resource_types
alter policy resource_types_manage on resource_types
  using (((organization_id = (select current_org_id())) and (select has_permission('services.manage'))));
alter policy resource_types_read on resource_types
  using (((organization_id = (select current_org_id())) and (select has_permission('services.view'))));

-- resources
alter policy resources_manage on resources
  using (((select has_permission('services.manage')) and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = (select current_org_id())))))));
alter policy resources_read on resources
  using (((select has_permission('services.view')) and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = (select current_org_id())))))));

-- role_permissions
alter policy role_permissions_manage on role_permissions
  using (((select has_permission('roles.manage')) and (exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = (select current_org_id())))))));
alter policy role_permissions_read on role_permissions
  using ((exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = (select current_org_id()))))));

-- roles
alter policy roles_manage on roles
  using (((organization_id = (select current_org_id())) and (select has_permission('roles.manage'))));
alter policy roles_read on roles
  using ((organization_id = (select current_org_id())));

-- service_categories
alter policy categories_manage on service_categories
  using (((organization_id = (select current_org_id())) and (select has_permission('services.manage'))));
alter policy categories_read on service_categories
  using (((organization_id = (select current_org_id())) and (select has_permission('services.view'))));

-- service_resource_requirements
alter policy srr_manage on service_resource_requirements
  using (((select has_permission('services.manage')) and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = (select current_org_id())))))));
alter policy srr_read on service_resource_requirements
  using (((select has_permission('services.view')) and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = (select current_org_id())))))));

-- service_staff
alter policy service_staff_manage on service_staff
  using (((select has_permission('services.manage')) and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = (select current_org_id())))))));
alter policy service_staff_read on service_staff
  using (((select has_permission('services.view')) and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = (select current_org_id())))))));

-- services
alter policy services_manage on services
  using (((organization_id = (select current_org_id())) and (select has_permission('services.manage'))));
alter policy services_read on services
  using (((organization_id = (select current_org_id())) and (select has_permission('services.view'))));

-- staff
alter policy staff_insert on staff
  with check (((organization_id = (select current_org_id())) and (select has_permission('staff.invite'))));
alter policy staff_read on staff
  using (((organization_id = (select current_org_id())) and (select has_permission('staff.view'))));
alter policy staff_self_update on staff
  using ((user_id = (select auth.uid())));
alter policy staff_update on staff
  using (((organization_id = (select current_org_id())) and (select has_permission('staff.edit'))));

-- staff_invites
alter policy invites_create on staff_invites
  with check (((organization_id = (select current_org_id())) and (select has_permission('staff.invite')) and (invited_by = (select current_staff_id()))));
alter policy invites_read on staff_invites
  using (((organization_id = (select current_org_id())) and (select has_permission('staff.invite'))));
alter policy invites_revoke on staff_invites
  using (((organization_id = (select current_org_id())) and (select has_permission('staff.invite'))));

-- staff_locations
alter policy staff_locations_manage on staff_locations
  using (((select has_permission('staff.edit')) and (exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = (select current_org_id())))))));
alter policy staff_locations_read on staff_locations
  using ((exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = (select current_org_id()))))));

-- staff_roles
alter policy staff_roles_manage on staff_roles
  using (((select has_permission('roles.manage')) and (exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = (select current_org_id())))))));
alter policy staff_roles_read on staff_roles
  using ((exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = (select current_org_id()))))));

