-- ============================================================
-- Migration: marketing campaigns — phase 1 (composer + send)
-- npx supabase migration new marketing_campaigns_phase1
--
-- docs/design/marketing-campaigns-design.md. Three tables: the campaign,
-- its per-recipient records (the store phase 2's Resend webhook updates),
-- and the single-use unsubscribe tokens behind the one-click link in
-- every campaign email. Campaigns do NOT write communications_sent —
-- that is the transactional audit trail; this is the marketing store.
--
-- organization_id on every row is written EXPLICITLY by the send route
-- from the staff session's org — never current_org_id(), which is null
-- under the service role. The same rule every service-role writer follows.
-- ============================================================

-- ------------------------------------------------------------
-- THE ADMIN GATE
-- No role-check helper existed: every gate so far is a permission key,
-- and admin + super_admin are simply the roles holding all of them. The
-- design names the ROLES, so this reads the roles rather than borrowing
-- a key from another domain. Same shape as has_permission(): security
-- definer, stable, calling current_staff_id() — which reads auth.uid()
-- from the session, unaffected by the definer boundary.
-- ------------------------------------------------------------

create or replace function is_admin()
returns boolean
language sql
security definer stable set search_path = public
as $$
  select exists (
    select 1
      from staff_roles sr
      join roles r on r.id = sr.role_id
     where sr.staff_id = current_staff_id()
       and r.name in ('admin', 'super_admin')
  );
$$;

comment on function is_admin() is
  'True when the calling staff member holds the admin or super_admin role. The gate for marketing campaigns (compose, send, read results): a role check, not a permission key, because the design names the roles. Add a permission key instead if campaigns ever need finer control.';

-- ------------------------------------------------------------
-- CAMPAIGNS
-- ------------------------------------------------------------

create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),

  subject         text not null,
  body_html       text not null,
  body_text       text not null,
  audience_filter jsonb,
  recipient_count integer,

  sent_by         uuid not null references staff(id),
  sent_at         timestamptz,
  status          text not null default 'draft'
    check (status in ('draft', 'sending', 'sent', 'failed')),
  created_at      timestamptz not null default now()
);

comment on table campaigns is
  'One row per campaign send. status tracks the send lifecycle; recipient_count is set at send time and never recomputed. Written by the send route under the service role; admins read and manage under RLS.';
comment on column campaigns.body_text is
  'Plain-text fallback, sent alongside body_html on every message. Required by CAN-SPAM; not optional.';
comment on column campaigns.audience_filter is
  'null = every opted-in client; {"last_visit_months": N} = opted-in clients with a completed appointment in the last N months. The snapshot of what was asked for, not a live filter.';
comment on column campaigns.recipient_count is
  'Size of the audience list at send time. Set once, never recomputed — the list is run ONCE and sent to, so preview and send cannot disagree.';
comment on column campaigns.status is
  'draft | sending | sent | failed. text + check, not an enum type.';

create index campaigns_org_created on campaigns (organization_id, created_at desc);

-- ------------------------------------------------------------
-- CAMPAIGN RECIPIENTS
-- ------------------------------------------------------------

create table campaign_recipients (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  client_id         uuid not null references clients(id),
  organization_id   uuid not null references organizations(id),

  resend_message_id text,
  sent_at           timestamptz,
  opened_at         timestamptz,
  clicked_at        timestamptz,
  unsubscribed_at   timestamptz
);

comment on table campaign_recipients is
  'Per-recipient record for a campaign send. resend_message_id links Phase 2 webhook events back to this row. opened_at/clicked_at/unsubscribed_at populated by the Phase 2 webhook. Inserted by the send route on Resend acceptance only — a row here means Resend took the message. Not fully append-only: the three event columns are updated by the webhook, under the service role.';
comment on column campaign_recipients.resend_message_id is
  'The id Resend returns on acceptance. Stored from phase 1 because phase 2 cannot exist without it: the webhook matches open/click/unsubscribe events to recipients by this value alone.';

create index campaign_recipients_campaign on campaign_recipients (campaign_id);
-- The webhook lookup: one event, one message id.
create index campaign_recipients_resend_message on campaign_recipients (resend_message_id);

-- ------------------------------------------------------------
-- UNSUBSCRIBE TOKENS
-- ------------------------------------------------------------

create table campaign_unsubscribe_tokens (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references campaigns(id),
  client_id       uuid not null references clients(id),
  organization_id uuid not null references organizations(id),

  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

comment on table campaign_unsubscribe_tokens is
  'Single-use tokens for the one-click unsubscribe link in every campaign email. Same pattern as cancellation_tokens: the id IS the token, minted per recipient at send time, claimed by the public unsubscribe route in the same statement that checks used_at is null. The route sets communication_opted_in = false on the token''s client and nothing else — no client id is ever accepted from the request.';

create index campaign_unsubscribe_tokens_client on campaign_unsubscribe_tokens (client_id);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table campaigns                   enable row level security;
alter table campaign_recipients         enable row level security;
alter table campaign_unsubscribe_tokens enable row level security;

create policy campaigns_manage on campaigns
  for all using (organization_id = current_org_id() and is_admin());

create policy campaign_recipients_read on campaign_recipients
  for select using (organization_id = current_org_id() and is_admin());

-- campaign_recipients: no authenticated insert/update/delete policies.
-- The send route inserts and the phase 2 webhook updates, both under
-- the service role. Insert and delete are revoked outright as well;
-- update is deliberately NOT revoked so the event columns' writer is
-- never grant-blocked.
revoke insert, delete on campaign_recipients from authenticated, anon;

-- campaign_unsubscribe_tokens: NO policies. The send route mints and
-- the public unsubscribe route claims, both under the service role;
-- nothing authenticated or anon can read or write a token. Deliberate —
-- the same absence cancellation_tokens carries.
