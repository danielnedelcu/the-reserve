# Marketing campaigns — design

Status: DESIGN, not built. Design-room session 2026-09-26. Owner-independent.

## What this is

A campaign composer built into The Reserve, letting super admins and admins
compose and send promotional emails (holiday rates, discounts, seasonal
offers) to opted-in clients without leaving the app. Built in two phases:
the composer + send (Phase 1), and the webhook-backed analytics (Phase 2).

The governing principle: **one-click unsubscribe in every campaign email,
handled server-side, updating the client record immediately.** Marketing
email without a working unsubscribe is a legal and deliverability risk.

## Consent

`communication_opted_in` covers marketing campaigns. Clients with this
flag true will receive campaigns. Existing clients are covered by
reasonable inference (the flag was labelled "non-essential communications"
at the time of setting); going forward, the public portal's account
settings should surface clear language that the flag covers promotional
emails too, so consent collected after that point is unambiguous. Record
this as a public-portal task.

The unsubscribe link in every campaign email must set
`communication_opted_in = false` on the client record immediately and
durably, without requiring the client to log in. The tokenized-link
pattern from the cancel flow applies here too.

## Who composes and sends

Super admin and admin only — not front desk, not providers. The permission
gate is the existing admin/super-admin role check (the same gate as
financial reporting), not a new permission key. No new migration for
permissions.

## Phase 1 — the campaign composer and send

### The data model

**`campaigns` table:**

- id uuid pk
- organization_id uuid not null (explicit, not current_org_id() — same
  pattern as every other service-role write)
- subject text not null
- body_html text not null (the composed message)
- body_text text not null (plain-text fallback — required by CAN-SPAM)
- audience_filter jsonb (null = all opted-in; {last_visit_months: N} for
  the recency filter)
- recipient_count integer (set at send time, not recomputed later)
- sent_by uuid not null references staff(id)
- sent_at timestamptz
- status text not null default 'draft' check ('draft', 'sending', 'sent',
  'failed')
- created_at timestamptz not null default now()
- RLS: org-scoped, readable by admin+super_admin

**`campaign_recipients` table:**

- id uuid pk
- campaign_id uuid not null references campaigns(id) on delete cascade
- client_id uuid not null references clients(id)
- organization_id uuid not null
- resend_message_id text (set when Resend accepts the message — the key
  that links a webhook event back to this recipient)
- sent_at timestamptz
- opened_at timestamptz (set by the webhook)
- clicked_at timestamptz (set by the webhook — first click)
- unsubscribed_at timestamptz (set by the webhook)
- RLS: org-scoped, readable by admin+super_admin

**`campaign_unsubscribe_tokens` table:**

- id uuid pk (the token in the unsubscribe link)
- campaign_id uuid not null references campaigns(id)
- client_id uuid not null references clients(id)
- organization_id uuid not null
- used_at timestamptz
- RLS: no authenticated policy (the unsubscribe route uses service role)

### The audience query

The recipient list at send time:

```sql
SELECT c.id, c.email, c.first_name, c.last_name
FROM clients c
WHERE c.organization_id = $org_id
  AND c.communication_opted_in = true
  AND ($last_visit_months IS NULL OR EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.client_id = c.id
      AND a.organization_id = $org_id
      AND a.status = 'completed'
      AND a.starts_at >= now() - ($last_visit_months || ' months')::interval
  ))
ORDER BY c.last_name, c.first_name;
```

This query powers both the PREVIEW (count + list) and the SEND (the
actual recipient rows). Run it once at send time, not twice — compute the
list, then send to that list, to avoid a race where a client opts out
between the preview and the send.

### The composer page `/marketing/campaigns`

Gated on admin+super_admin. Two views:

**Campaign list:** past campaigns, newest first — subject, sent_at,
recipient_count, and (Phase 2) open rate. Status badge (draft / sending /
sent / failed). A "New campaign" button.

**Campaign composer (new or draft):**

- Subject line
- Body — a rich text editor or a simple textarea (owner's choice; a
  textarea is simpler and produces cleaner plain-text; a rich-text editor
  produces HTML that needs sanitization). Start with textarea, upgrade
  later.
- Audience selector: "All opted-in clients" (default) or "Clients who
  visited in the last [N] months" — a select with options 1 / 3 / 6 / 12.
- Preview button: shows "N clients will receive this" with a scrollable
  list of names (so the sender can sanity-check before sending). This is
  the audience query's COUNT + LIST, not the send.
- Send now button: confirms ("Send to N clients?"), then fires.

### The send action `POST /api/marketing/campaigns`

Admin+super_admin gate. On POST:

1. Run the audience query to get the final recipient list.
2. Insert the `campaigns` row (status = 'sending', recipient_count = list
   length).
3. For each recipient, in sequence (not parallel — Resend rate limits):
   a. Generate an unsubscribe token (insert into
   `campaign_unsubscribe_tokens`).
   b. Send via Resend, with the unsubscribe link in the footer:
   `${siteUrl}/unsubscribe/${token}`.
   c. On Resend acceptance: insert a `campaign_recipients` row with the
   `resend_message_id` Resend returns.
   d. On Resend failure: log the failure, continue to the next recipient
   (best-effort per recipient — a single failure does not abort the
   campaign).
4. Update the `campaigns` row to status = 'sent', sent_at = now().
5. Return success.

**The send is synchronous for now** (small list — a spa has tens to low
hundreds of opted-in clients, not thousands). If the list grows large
enough that a synchronous send times out on Vercel (>10s), queue it via
pg_cron or a background job. Note this as the scale trigger.

**The plain-text fallback** is required by CAN-SPAM. Every campaign email
carries both `html` and `text` in the Resend call. The text version strips
HTML tags from the body and appends the unsubscribe URL as plain text.

### The unsubscribe flow

`GET /api/public/unsubscribe/[token]` — public, no auth:

1. Validate the token (exists, not used).
2. Set `communication_opted_in = false` on the client.
3. Mark the token used.
4. Return a friendly confirmation page ("You've been unsubscribed from
   promotional emails from The Reserve. You will still receive
   appointment confirmations and reminders."). This distinction matters —
   transactional emails continue regardless.

This is a Door 0 route (tokenized, service role, anon holds no direct
write path) — same architecture as the cancel link. The token is single-
use. The confirmation page is a public Nuxt page, no auth required.

### What the Resend setup needs

- A Resend webhook endpoint configured for Phase 2 events (configured in
  Phase 2, but the Resend project may need a sending domain separate from
  the transactional domain — check if Resend recommends separate domains
  for transactional vs. marketing sends to protect deliverability).
- The existing `RESEND_API_KEY` covers both for now.
- Every campaign email must include a `List-Unsubscribe` header (Resend
  can add this automatically if configured — check before building a
  manual header). This is required by major email providers (Gmail,
  Outlook) for bulk sends.

## Phase 2 — webhook-backed analytics

### The Resend webhook endpoint `POST /api/webhooks/resend`

Resend fires events to this endpoint for every tracked email event:
`email.opened`, `email.clicked`, `email.unsubscribed`, `email.bounced`,
`email.complained`. The payload carries the `resend_message_id`.

The route:

1. Verify the Resend webhook signature (Resend signs payloads — verify
   before processing, same discipline as the Stripe webhook).
2. Look up the `campaign_recipients` row by `resend_message_id`.
3. If found: update the relevant timestamp column (`opened_at`,
   `clicked_at`, `unsubscribed_at`). For `email.unsubscribed` and
   `email.complained`: also set `communication_opted_in = false` on the
   client record.
4. If not found (the event is for a transactional email, not a campaign):
   ignore silently. The `resend_message_id` only exists in
   `campaign_recipients` for campaign sends; transactional sends don't
   create a recipient row.

**The webhook secret** goes in Supabase Vault alongside
`communications_job_secret` and `communications_site_url`. Add it to the
deployment doc's Vault section and the env example.

### The analytics view

On the campaign detail page (clicking a sent campaign in the list):

- Recipient count, open count, click count, unsubscribe count
- Open rate (opened / sent), click rate (clicked / sent)
- A recipient list with per-row status icons (sent / opened / clicked /
  unsubscribed)
- Sorted by status (unsubscribed first as the most important to know,
  then clicked, then opened, then sent-only)

**Note on open-rate accuracy:** email open tracking relies on a 1px
tracking pixel, which many email clients (Apple Mail's Mail Privacy
Protection especially) load automatically regardless of whether the human
actually read the email. Open rates are directionally useful but not
precise. State this honestly in the UI ("approximate — some email clients
load tracking pixels automatically").

## The two-phase build order

### Phase 1: composer + send (owner-independent, buildable now)

Migration: `campaigns`, `campaign_recipients`,
`campaign_unsubscribe_tokens` tables.
Route: `POST /api/marketing/campaigns` (the send action).
Route: `GET /api/public/unsubscribe/[token]` (the unsubscribe action).
Page: `/marketing/campaigns` (list + composer).
Page: `/unsubscribe/[token]` (public confirmation).
Nav entry: "Campaigns" under marketing, gated on admin+super_admin.

### Phase 2: webhook + analytics (after Phase 1 is proven)

Route: `POST /api/webhooks/resend`.
Campaign detail page with the analytics view.
Resend webhook configured in the Resend dashboard pointing at the prod URL.
Vault entry: the Resend webhook signing secret.

## Must-not-break

- `communication_opted_in` on clients — the unsubscribe flow writes it;
  the send flow reads it. The field is the source of truth for whether a
  client receives campaigns. Never bypass it.
- The append-only `communications_sent` table — campaigns do NOT write to
  this table. Campaign sends are tracked in `campaign_recipients`, which
  is purpose-built for the analytics events. The two tables serve
  different purposes: `communications_sent` is the transactional audit
  trail; `campaign_recipients` is the marketing analytics store.
- Transactional emails (confirmation, reminder, cancellation) — they fire
  regardless of `communication_opted_in`. The unsubscribe page must state
  this clearly.

## Deferred / out of scope for this build

- Scheduled sends ("send this Monday at 10am") — a pg_cron job or a
  Resend scheduled send. Add to the campaigns composer once v1 is proven.
- Service-category audience filtering ("clients who've had a massage") —
  Phase 3 if the owner wants segmentation beyond recency.
- Membership-tier targeting — blocked on §3 tiers anyway.
- A/B testing subject lines — marketing platform territory.
- SMS campaigns — deferred alongside SMS transactional.
- Campaign templates — the owner composes fresh each time for now.

## Relationship to other docs

- `docs/design/client-communications-design.md` — the transactional
  lifecycle this feature sits alongside. Campaigns share the Resend
  sender and the `communication_opted_in` flag, but NOT the
  `communications_sent` table.
- `docs/deployment.md` — Phase 2 adds a Resend webhook signing secret
  to the Vault section. The send endpoint is a new admin-gated route
  (not public). The unsubscribe endpoint is a new Door 0 route.
- `architecture.md` — the unsubscribe route is a new Door 0 path
  (tokenized, service role, anon no direct write); add it to the diagram
  alongside the cancel link and the lead capture endpoint.

## Pre-launch notes

- Confirm with Resend whether a separate sending domain for marketing
  (vs. transactional) is recommended. If yes, configure it before the
  first campaign send to protect transactional deliverability.
- Add `List-Unsubscribe` header support — check if Resend adds it
  automatically for bulk sends or if it must be set manually.
- Test the full unsubscribe flow end-to-end before the first real campaign
  (click unsubscribe in a test email, confirm `communication_opted_in`
  flips, confirm the confirmation page renders).
- The Phase 2 webhook requires a deployed URL — cannot be tested locally
  without a tunnel. Note this in the deployment doc alongside the
  communications job path.
