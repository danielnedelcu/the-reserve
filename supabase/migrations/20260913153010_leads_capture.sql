-- ============================================================
-- Migration: marketing lead capture (§8, phase 1 — schema only)
-- npx supabase migration new leads_capture
--
-- The front of the membership-admission funnel:
--   lead → prospect (§6) → approved (§6) → enrolled/active (§3, owner-blocked)
-- A lead is the stage BEFORE a prospect: contact details and an interest,
-- captured by a public landing page. Its own entity, deliberately not an
-- early-stage prospect_intake row — that table's PHI-adjacent meaning,
-- RLS and retention would all be wrong for it. Same pattern as
-- staff_invites being separate from staff.
--
-- Design: docs/design/leads-design.md. This phase is the tables, the
-- permissions, RLS, and the retention purge. The public capture endpoint
-- (phase 2) writes under the service role; nothing here grants anon a
-- write path, and that absence is the design.
-- ============================================================

-- ------------------------------------------------------------
-- LEADS
-- ------------------------------------------------------------

create table leads (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),

  first_name      text not null,
  last_name       text not null,
  email           text not null,
  phone           text,

  interest        text not null check (interest in ('membership', 'service', 'inquiry')),
  source          text not null default 'manual',
  status          text not null default 'new'
                    check (status in ('new', 'contacted', 'qualified', 'converted', 'lost')),

  consent         boolean not null default false,
  consent_at      timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Consent and its timestamp are one fact: recorded together or not at all.
  check (consent = (consent_at is not null))
);

comment on table leads is
  'A person who expressed interest through a public landing page and is not yet a prospect. CONTACT INFORMATION ONLY — no health data, no consent to treatment, no token, no review decision; the health machinery does not apply. Written by the public capture endpoint under the service role (no anon insert policy exists, deliberately) and managed by staff holding leads.manage. Lifecycle new → contacted → qualified → converted | lost, kept to five on purpose. Non-converted leads are purged after one month by purge_leads(); converted leads are kept because they head a provenance chain (leads → prospect_intake.lead_id → clients).';

comment on column leads.interest is
  'A generic, TIER-INDEPENDENT option set: membership | service | inquiry. Deliberately NOT tied to membership tiers, which do not exist yet (§3, owner-blocked). Refinable when tiers land; not dependent on them.';
comment on column leads.source is
  'Where the lead came from — the head of the provenance chain, and what "which campaign produced this member" resolves to. The public capture endpoint sets the landing page or campaign explicitly. Defaults to ''manual'' so a lead a staff member enters by hand (a phone inquiry, a walk-in conversation) records its origin without the form having to remember to: a staff conversation IS meaningful provenance, distinct from any campaign.';
comment on column leads.status is
  'new → contacted → qualified → converted | lost. text + check, not an enum type, so adding a value is a constraint swap. converted is the funnel handoff: the lead became a prospect and its row is kept.';
comment on column leads.consent is
  'Marketing-contact consent as captured by the landing page. Recorded from day one so the data model is ready even though the consent POLICY (wording, shelf life, jurisdiction) is parked as owner/legal-adjacent. true requires consent_at; a lead with no consent captured is false/null, never a guess.';
comment on column leads.consent_at is
  'When consent was given. Present exactly when consent is true (checked). The timestamp is what a future retention or re-consent rule will be measured from.';

-- The work queue: staff read the org's leads by status, oldest first.
create index leads_org_queue on leads (organization_id, status, created_at desc);
-- Dedupe / lookup by address, for the capture endpoint and the list search.
create index leads_org_email on leads (organization_id, lower(email));

create trigger trg_leads_touch
  before update on leads
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------
-- LEAD NOTES — append-only, authored, dated
-- ------------------------------------------------------------

create table lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  staff_id   uuid not null references staff(id),
  body       text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

comment on table lead_notes is
  'Staff notes on a lead ("called, left voicemail"). The client_notes pattern without the health tier: leads carry no health data, so there is no sensitivity split and no audited read path. APPEND-ONLY by policy omission — no update or delete policies exist and none will; a correction is a new note. Notes go with their lead when the retention purge deletes it (cascade); a converted lead is never purged, so its notes survive with it. Scoped to the org through the parent lead.';

create index lead_notes_lead on lead_notes (lead_id, created_at desc);

-- ------------------------------------------------------------
-- PROVENANCE — prospect_intake.lead_id
-- ------------------------------------------------------------

-- Nullable: a prospect can arrive without a lead (someone who walks in and
-- applies directly). Populated by the conversion action in phase 4 —
-- "send the intake form from the lead record" — which issues the link,
-- flips the lead to converted, and threads this FK in one move. The
-- column lands now so the chain's target exists before anything writes it.
alter table prospect_intake
  add column lead_id uuid references leads(id) on delete set null;

comment on column prospect_intake.lead_id is
  'The lead this prospect came from, if any — the middle link of the provenance chain leads → prospect_intake → clients. Nullable because a prospect can arrive with no lead. on delete set null: if a lead row is ever removed by hand, the prospect survives and the chain simply ends here.';

create index prospect_intake_lead on prospect_intake (lead_id) where lead_id is not null;

-- ------------------------------------------------------------
-- PERMISSIONS
-- ------------------------------------------------------------
-- Own keys, NOT a reuse of forms.responses.view: leads carry no PHI, so a
-- future marketing-only role can hold leads.* without the intake and
-- health permissions. Catalog checked: no leads.* key exists.

insert into permissions (key, description) values
  ('leads.view',   'See marketing leads and their notes'),
  ('leads.manage', 'Work leads: change status, add notes, and send them an intake form');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'leads.view'), ('super_admin', 'leads.manage'),
  ('admin',       'leads.view'), ('admin',       'leads.manage'),
  ('front_desk',  'leads.view'), ('front_desk',  'leads.manage')
) as p(role_name, key) on p.role_name = r.name;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Reads by leads.view; staff edits by leads.manage; the PUBLIC capture
-- path writes under the service role. anon has no policy on either table
-- and must never get one — a landing-page form is open by design, so the
-- endpoint (honeypot, DB-backed rate limit, shape validation) is the only
-- thing standing between the internet and this table. That absence is
-- the design, same as the prospect submit path.
-- ------------------------------------------------------------

alter table leads      enable row level security;
alter table lead_notes enable row level security;

create policy leads_read on leads
  for select using (organization_id = current_org_id() and has_permission('leads.view'));
-- for all: staff holding leads.manage may also enter a lead by hand (a
-- phone inquiry; source defaults to 'manual') and correct one. USING
-- doubles as WITH CHECK, so a row cannot be written into another
-- organisation.
create policy leads_manage on leads
  for all using (organization_id = current_org_id() and has_permission('leads.manage'));

create policy lead_notes_read on lead_notes
  for select using (
    has_permission('leads.view')
    and exists (select 1 from leads l where l.id = lead_id and l.organization_id = current_org_id())
  );
create policy lead_notes_insert on lead_notes
  for insert with check (
    staff_id = current_staff_id()          -- cannot note "as" someone else
    and has_permission('leads.manage')
    and exists (select 1 from leads l where l.id = lead_id and l.organization_id = current_org_id())
  );
-- Append-only: no update or delete policies on lead_notes, now or later.

-- ------------------------------------------------------------
-- RETENTION — one clock for everything that did not convert
-- ------------------------------------------------------------

create or replace function purge_leads()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  -- One month for every NON-CONVERTED status: new, contacted, qualified
  -- and lost share the clock (a lost lead is cheap to keep for a month in
  -- case it re-engages; two windows would be complexity for nothing).
  --
  -- The status list is an ALLOWLIST, never a NOT IN. converted is absent
  -- on purpose: it heads a provenance chain (leads → prospect_intake →
  -- clients) and purging it would sever "which campaign produced this
  -- member". Any status added later is likewise KEPT until someone adds
  -- it here — omission means kept, which is the safe direction to fail
  -- in. Same shape as purge_prospect_intake. Notes follow by cascade.
  delete from leads
   where status in ('new', 'contacted', 'qualified', 'lost')
     and created_at < now() - interval '1 month';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function purge_leads() is
  'Deletes leads that did not convert, one month after capture; their notes follow by cascade. Statuses are an allowlist so converted — the head of the provenance chain — and any future status are kept by omission, never swept by default.';

revoke execute on function purge_leads() from public, anon, authenticated;

-- Scheduled beside the data, like the prospect purge, for the same reason:
-- an external job that stops firing leaves stale rows with nothing showing
-- an error. This narrows that surface without removing it — a job can be
-- unscheduled or fail every run and still look quiet, and the app's roles
-- cannot read cron.job. The OUTCOME canary (no lead past the window in a
-- purgeable status) is owed to a verify:leads script in a later phase.
select cron.schedule(
  'purge-leads',
  '45 3 * * *',                       -- nightly, after the prospect purge
  $$select purge_leads()$$
);
