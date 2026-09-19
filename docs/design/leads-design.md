# Marketing lead capture (§8) — design

Status: PHASE 1 (schema) SHIPPED 2026-09-13
(`supabase/migrations/20260913153010_leads_capture.sql`). PHASE 2 (public
capture endpoint) SHIPPED 2026-09-13 — `server/api/public/leads/index.ts`.
PHASE 3 (staff UI + live indicators) SHIPPED 2026-09-18. PHASE 4
(conversion) built 2026-09-18 — migration `20260919021059`,
`convert_lead()`, `form_links.lead_id`; the feature is complete. Owner-INDEPENDENT (no tier answers needed).
Design-room session 2026-09-12. `[AS-BUILT]` marks where the SQL
deviates from the prose below.

## What this is

The front of the membership-admission funnel. Public landing pages (built
OUTSIDE this app, on the marketing site) capture interest; the captured
lead lands in The Reserve, where staff see it, note on it, and either
pursue it into a formal intake or mark it lost. Deliberately NOT a CRM —
leads, statuses, notes, and a conversion handoff, nothing more.

The full funnel, and where this sits:

    lead (interest captured)  ← THIS FEATURE (front)
      → prospect (intake submitted)   ← §6, built
        → approved                    ← §6, built
          → enrolled / active         ← §3 tail, owner-blocked

A lead is the stage BEFORE a prospect: minimal info, no consent, no health
data, no token, no review-decision. It is its own entity, not an
early-stage prospect — cramming it into prospect_intake would pollute that
table's PHI-adjacent meaning, RLS, and retention. Same pattern as
staff_invites being separate from staff: a distinct thing that can BECOME
the next thing.

## The `leads` table

- id, organization_id (+ RLS)
- first_name, last_name, email, phone (phone optional)
- interest — a generic, TIER-INDEPENDENT option set: 'membership',
  'service', 'inquiry' (see decision A). NOT tied to membership tiers,
  which do not exist yet; refinable when §3 lands, not dependent on it.
- source — set by the landing page, records which page/campaign captured
  the lead (the head of the provenance chain). [AS-BUILT] `not null
  default 'manual'`: staff holding leads.manage may enter a lead by hand
  (a phone inquiry), and that row has no landing page to name — the
  default records "staff conversation" as its origin without the entry
  form having to remember to. The public endpoint still sets its real
  source explicitly.
- status — 'new' | 'contacted' | 'qualified' | 'converted' | 'lost'
  (text + check constraint, the house enum idiom).
- created_at, updated_at.
- [AS-BUILT] consent (boolean, default false) + consent_at (timestamptz,
  nullable), paired by a check (`consent = (consent_at is not null)`) so
  a row cannot claim consent without saying when. Captured from day one
  per the Deferred note below, so the model is ready before the policy is.
- No PHI. A lead carries contact info only — the health machinery does
  not apply here.

## Lifecycle

    new → contacted → qualified → converted | lost

- new: just captured, untouched.
- contacted: staff has reached out.
- qualified: worth pursuing into an application.
- converted: became a prospect (the funnel handoff — see Conversion).
- lost: not pursuing.

Keep it to these five. Status sprawl is how lightweight lead tracking
rots into a CRM nobody updates; five is already generous.

## Conversion — how a lead becomes a prospect

Conversion is not a bare status flip; it is an ACTION that reuses existing
machinery. From the lead detail page, a staff member "sends them an intake
form" — issuing the tokenized link the §6 form engine already builds. That
single act:

1. issues a form_link for the prospect_intake form (existing flow),
2. flips the lead to `converted`,
3. threads the provenance FK: the resulting prospect_intake row carries
   `lead_id` pointing back at this lead.

So conversion = "issue the intake link from the lead record", which
creates the prospect and the provenance link in one move. No new
conversion concept — it is the form-send flow, triggered from a lead,
recording where the prospect came from.

[AS-BUILT] The thread spans two features, so it needed a deliberate
carrier: `form_links.lead_id` (nullable; never together with client_id,
by check constraint) is set at conversion, and `submit_form_response` —
the only place a prospect row is created — copies it onto
`prospect_intake.lead_id`. The chain is whole the moment the person
answers and needs nothing from anyone at that moment. Steps 1 and 2 are
one transaction in `convert_lead()`, SECURITY INVOKER: the caller's own
RLS authorises the flip (leads.manage) and the link (forms.send), and
either refusal rolls back both. The route is the existing
`POST /api/forms/:key/links` with a `leadId`, so the /forms send dialog
and the lead page share one path. Provenance is visible from both ends:
the lead page links to the application once it exists, the prospect page
names the lead and source it came from.

## Provenance chain (the one CRM-ish thing worth having)

Thread an FK at each stage so the funnel is traceable end to end:

    leads.id  ←  prospect_intake.lead_id  ←  clients (via the prospect's
                                              eventual enrollment)

This answers "which campaign produced which member" — marketing ROI —
and is nearly free: one nullable FK per stage. `prospect_intake.lead_id`
is nullable (a prospect can arrive without a lead — someone who walks in
and applies directly). Keep the chain intact; do not purge a link out of
the middle of it (see Retention).

## Public capture endpoint — the new hard part

The landing page POSTs to a PUBLIC, UNAUTHENTICATED capture endpoint. This
is the prospect-submission security model MINUS the token (a landing-page
form is open by design — anyone can fill it), which makes abuse the harder
problem, since a token no longer bounds it.

Reuse from the §6 public-submission model:

- Service-role write; NO anon insert policy on `leads` anywhere. The
  endpoint is the only PUBLIC writer. [AS-BUILT] Staff holding
  leads.manage can also insert and correct leads directly (the policy is
  `for all`, org-scoped) — a hand-entered lead from a phone call is a
  legitimate origin, recorded as source 'manual'. anon still has nothing.
- DB-backed rate limiting (the form_submission_attempts pattern —
  HMAC'd IPs keyed by FORM_IP_PEPPER, or a leads-specific equivalent),
  fail-closed if the pepper is absent. [AS-BUILT] The SAME table, with
  `token is null` as the lead discriminator (the prospect route records
  a token on every attempt, garbage included) and a tighter per-address
  cap of 5 per hour — a person fills a landing page once. Counting only
  null-token rows keeps lead spam from locking a prospect out from the
  same address. The discriminator is a convention, asserted by
  verify:leads from the code that decides it; an `endpoint` column is
  the bounded tightening if it ever needs to be a constraint.
- Server-side shape validation; reject unknown/oversized input.

New, because there is no token:

- HONEYPOT field — a hidden field bots fill and humans do not; reject
  submissions that fill it. Free, no user friction, catches naive bots.
  This is the baseline first layer. [AS-BUILT] The field is `website`
  (`LEAD_HONEYPOT_FIELD`), allowed by the strict schema so a filled one
  is CAUGHT rather than rejected as unknown; a trip is recorded as a
  rejected attempt and answered with the identical success body.
- Rate limiting is the second layer (bounds a single abuser; distributed
  bots evade per-IP, which is the known residual).
- CAPTCHA is DEFERRED — the escalation if spam actually materialises.
  Recorded as deferred-with-trigger: add it (Turnstile, privacy-
  preserving, low-friction) if honeypot + rate limiting prove
  insufficient in practice. Decision keyed to observed abuse, not
  built preemptively — but note the landing pages' discoverability
  raises the odds vs the token-gated prospect form.

## Two questions the endpoint had to answer that the design left open

**Which organisation?** A public POST carries no session and no token, so
nothing in the request can be trusted to name the org — a page saying
"org X" would let anyone post into any org. [AS-BUILT] The org is a
SERVER-SIDE setting, `LEADS_ORGANIZATION_ID`, fail-closed (503 when
absent). Single-org today, so that is the whole answer; the bounded
upgrade for a second org with its own landing pages is a per-page
capture key resolved to an org in the database. Deliberately not "the
first organisations row", which is a hardcode wearing a query.

**Which origins?** The landing pages live on the marketing site, a
different origin, so the browser preflights. [AS-BUILT] Exact origins
from `LEADS_ALLOWED_ORIGINS`, never `*`; unset means no cross-origin
caller. A request naming any other origin is refused with 403 for the
preflight and the POST alike. Honest limit: CORS is enforced by browsers,
so a script with no Origin header is not stopped by it and cannot be —
the origin check keeps other websites from using the form; the honeypot
and the rate limit are what stand against scripts.

## Retention

- 1 month for all NON-CONVERTED statuses: new, contacted, qualified,
  lost all purge after 1 month. (Decision B: one clock, `lost` on the
  same 1-month window as the rest — simpler than two windows, and a lost
  lead is cheap to keep for a month in case it re-engages.)
- `converted` is EXEMPT — it is the head of a provenance chain now
  (lead → prospect → client); purging it would sever "which campaign
  produced this member". Kept indefinitely (or a much longer horizon).
- Purge by an ALLOWLIST of statuses, not by "un-converted", so `converted`
  and any future status are kept BY OMISSION — the same fail-safe shape as
  the prospect_intake purge (a status the purge does not name is kept, not
  swept). pg_cron, scheduled in the migration, with an outcome canary in a
  verify script (nothing past the window in a purgeable status), since the
  app's roles cannot read cron.job. [AS-BUILT] The canary lives in
  verify:leads, alongside a both-directions purge check: a backdated
  `new` lead and its note go, a backdated `converted` lead survives.

## Permissions

New keys, NOT a reuse of forms.responses.view (decision 4): 'leads.view'
(see the leads list + detail) and 'leads.manage' (edit status, add notes,
convert). Granted to front_desk and admin (+ super_admin). Own keys so a
future marketing-only role can hold leads._ without the intake/health
permissions — leads carry no PHI, so their audience can legitimately
differ from intake's. Seed + grant in the migration; check the catalog
first (do not mint a duplicate — forms._ / leads.\* are distinct).

## Lead notes

`lead_notes` following the client_notes pattern: append-only, authored
(staff_id), dated. "Staff added a note about following up." No health
tier (leads carry no health data), so no sensitivity split — simpler than
client_notes. Read/write gated on leads.view / leads.manage.

## The management UI

The /intake review-list → detail pattern, re-aimed at leads:

- a leads list (filter by status; oldest-or-newest first — a work queue,
  not a feed), gated on leads.view;
- a lead detail: contact info, interest, source, the notes thread, a
  status control, and the "send intake form" (convert) action;
  [AS-BUILT] the status control and its route both draw from
  `LEAD_MANUAL_STATUSES` (new, contacted, qualified, lost) — `converted`
  is reachable only through the phase-4 action, the route refuses it by
  name, and a converted lead cannot be moved back by hand. The convert
  button is present but disabled, with the reason on the screen, until
  phase 4.
- gated nav entry (leads.view), and — consistent with the prospect
  work — consider a live indicator for new leads later (not v1 unless
  wanted; the prospect nav-dot + bell pattern is the model if so).
  [AS-BUILT] Shipped in phase 3 as an ARRIVAL alert: the nav dot counts
  leads in `new` (queue state, shared, no last-seen), and a
  `lead.captured` bell notification fans out to leads.view holders. Both
  clear on FIRST TOUCH — any move out of `new` marks every recipient's
  copy read (a colleague picking a lead up clears everyone's bell), and
  moving back to `new` does not re-announce. The notification is written
  by a trigger on `leads`, not by the capture route, so a lead entered by
  hand is announced identically; `leads` joined the realtime publication
  in the same migration, and useLeadQueue carries the re-count-on-join
  and on-visible defences from useProspectQueue — the pane tab that was
  open across the push demonstrated the documented incident exactly (a
  pre-publication subscription reported SUBSCRIBED and received nothing
  until reload). The /leads list refetches whenever the queue count
  changes, so it never contradicts the dot above it.

## What lives where (the boundary)

- Landing pages: the MARKETING SITE, outside this app — public, SEO,
  fast, separate deploy. Not built here. They only need to POST to the
  capture endpoint.
- The Reserve app exposes: ONE public endpoint (capture) + the
  authenticated lead-management UI. Everything else stays behind auth.

## Build order (phases, for the eventual Claude Code brief)

1. Migration: leads + lead_notes tables, leads.\* permissions + grants,
   the retention purge (pg_cron, allowlist), RLS. Push-first.
2. Public capture endpoint: service-role write, honeypot + rate limit,
   fail-closed, shape validation. The security-critical piece — verify
   both directions (anon has no write path; honeypot rejects; rate limit
   limits), same rigor as the §6 public submit.
3. Lead management UI: list + detail + notes + status control.
4. Conversion action: "send intake form from lead" → issues the link,
   flips to converted, threads prospect_intake.lead_id. Reuses §6 send.

## Deferred / owner-adjacent

- CAPTCHA (trigger: observed spam).
- Marketing-consent question on the landing page + its shelf life —
  a landing page capturing contact info "so we can tell you about
  membership" implies a marketing-contact consent, which may carry
  jurisdictional rules. Owner/legal-adjacent; flag, do not block. The
  capture endpoint should probably record a consent boolean + timestamp
  from day one so the data model is ready even if the policy is not.
- Live new-lead indicator (nav dot / bell) — the prospect pattern
  applies if wanted; not v1 unless requested.
- Tier-specific interest options (when §3 lands; the generic set works
  until then and does not depend on it).

## Relationship to other docs

- §6 prospective-onboarding-design.md — conversion hands off to that
  flow; the capture endpoint reuses its public-submission security model.
- The provenance chain extends into it (prospect_intake.lead_id) and
  through to clients.
- architecture.md — the capture endpoint is a second public/anon inbound
  path; it belongs on the doors diagram as another Door-0-class caller
  (unauthenticated, but open rather than token-gated — a distinct, MORE
  exposed variant worth its own note).
