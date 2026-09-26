# Client communications lifecycle — design

Status: DESIGN, not built. Design-room session 2026-09-26. Owner-independent.

## What this is

A complete automated communication lifecycle for the appointment journey —
every touch from booking through post-visit — plus the cancellation-fee
engine the queued roadmap item has been waiting for. Designed as ONE
coherent system with shared infrastructure, not seven separate features
bolted on.

The governing principle: **the client should never have to wonder what
happens next.** Every appointment state change sends a communication;
every time-sensitive moment gets a reminder; and the spa's policies
(cancellation fee, intake requirement) are enforced through the same
communication channel, not as a surprise at the desk.

## The seven touchpoints

### Transactional (always fire, regardless of opt-in)

1. **Booking confirmation** — fires immediately when an appointment is
   created. "Your appointment is confirmed: [service], [provider],
   [date/time], [location details]." Includes the cancel link (see below)
   and a note about the cancellation policy ("cancellations within 24
   hours of your appointment may incur a fee").

2. **Day-before reminder** — fires ~24 hours before the appointment
   (the pg_cron job runs nightly and finds appointments the next day).
   "Your appointment is tomorrow: [details]." Includes the cancel link
   and a clear warning: "Cancellations after [time] will incur a $50
   late cancellation fee. Your first late cancellation is waived as a
   courtesy."

3. **Cancellation notice** — fires when an appointment is cancelled
   (whether by staff or via the cancel link). Confirms the cancellation,
   states whether the fee was charged or waived, and (if waived) notes
   the lifetime waiver has been used.

4. **Incomplete intake form reminder** — fires N days before the
   appointment when the required intake/waiver has not been completed.
   Reuses the existing form-link machinery (the tokenized link the §6
   form engine already issues). A pg_cron job finds appointments N days
   out where `requires_intake` is true and no completed waiver exists
   for the client. Default: 3 days before.

### Non-transactional (fire on opt-in, under the general communication basket)

5. **Birthday appreciation** — a pg_cron job runs daily, finds clients
   whose birthday is today (matching month + day from `date_of_birth`),
   and sends a warm message. Content: the spa's choice (a discount, a
   gift, or simply a warm note). Does not fire if the client is opted out
   of non-transactional communications.

6. **Post-appointment follow-up** — fires the day after the appointment
   (another pg_cron check). "Thank you for your visit — we hope you
   enjoyed your [service]." Natural moment to invite a rebook and
   optionally request a review. Does not fire if opted out.

### The cancel-via-link action (embedded in touchpoints 1 and 2)

7. **Cancel via link** — not a communication itself, but the action that
   touchpoints 1 and 2 point to. A tokenized URL in the email opens a
   minimal public page; the client confirms and the server cancels the
   appointment, enforcing the fee policy. See "The cancel link" below.

## Communication preferences

One field on the `clients` record (and eventually on the public-portal
account settings):

- `communication_channel`: `'email' | 'sms' | 'both'` — HOW to reach
  the client. Nullable, defaults to `'email'`. Staff can set it on the
  client profile today; the public portal reads and writes the same field
  when it is built. SMS is deferred (see below) but the field lands now
  so no migration is needed later and staff can start recording
  preferences.

- `communication_opted_in`: boolean, default true — whether the client
  receives non-transactional communications (birthday, follow-up). Can
  be set by the client (public portal) or by staff. Transactional
  communications fire regardless of this flag — it covers only touchpoints
  5 and 6.

Staff view: both fields visible and editable on the client profile page,
under a "Communication preferences" section.

## SMS

**Deferred.** The field (`communication_channel`) lands in the data model
now, but the SMS delivery path is NOT built in this phase. Every scheduled
job and route in this phase sends email only, checking
`communication_channel` and treating `'sms'` and `'both'` as `'email'`
until SMS is built. A TODO comment marks each delivery call.

When SMS is added: Twilio is the natural integration (connector available).
TCPA rules apply — transactional SMS is generally covered by booking
consent; the birthday/follow-up messages require explicit SMS opt-in, which
is a stricter bar than the general `communication_opted_in` flag. That is
a legal/policy question for the SMS phase, not this one.

## The shared infrastructure

### The pg_cron communication job

A single daily scheduled job (or a small family of jobs, one per
time-triggered touchpoint) rather than separate cron entries per feature:

```
-- Nightly, after midnight local time (accounting for the location's tz)
-- 1. Day-before reminders: find appointments tomorrow, not yet reminded
-- 2. Intake reminders: find appointments N days out, intake not complete
-- 3. Post-visit follow-ups: find appointments yesterday, status completed
-- 4. Birthday messages: find clients whose birthday is today
```

Each check is a SELECT + Resend call (server-side, service role, same as
the form-link email). A `communications_sent` log table (appointment_id,
kind, sent_at, channel) prevents double-sends — the job checks this table
before sending, so a job that runs twice does not double-email.

The `communications_sent` table is also the audit trail: "when was this
client last contacted, and about what."

### The cancel link

Tokenized URL in the confirmation and reminder emails:
`/cancel/<token>` — a public, no-auth page.

- Token is a single-use UUID stored in a `cancellation_tokens` table:
  `(id, appointment_id, expires_at, used_at)`. Expires at appointment
  time (you cannot cancel via link after the appointment starts). Single-
  use: claiming it marks `used_at`, and the route checks this atomically.
- The public cancel page shows: appointment details, the policy warning,
  and a confirm button. No account required.
- On confirm, the server route (service role):
  1. Validates the token (exists, not used, not expired).
  2. Checks the cancellation window (is it within 24 hours?).
  3. If within 24 hours: applies the fee policy (see below).
  4. Cancels the appointment (sets `status = 'cancelled'`).
  5. Marks the token used.
  6. Sends the cancellation confirmation email (touchpoint 3).
- Same token-gated route pattern as the intake form submit — proven
  architecture, same security model (anon holds no direct write path;
  the route writes under service role; token is claimed atomically).

## The cancellation fee engine

This is the queued roadmap item, now triggered. It uses the Stripe
card-on-file (4b) and the append-only ledger already built.

### Policy

- **Window:** cancellations within 24 hours of the appointment start time
  carry a fee.
- **Fee:** $50 flat.
- **First offense waived:** each client has a lifetime waiver
  (`late_cancellation_waiver_used` boolean on `clients`, default false).
  The first late cancellation is forgiven and the flag is set. Every
  subsequent late cancellation charges $50.
- **No card on file:** if the client has no consented card, the fee cannot
  be charged. The cancellation proceeds, the waiver is NOT consumed (they
  did not get the benefit of the waiver — they just could not be charged),
  and the staff are notified so they can collect at the next visit. This
  is the policy decision that avoids punishing a client for the spa's own
  card-on-file gap.

### Mechanics

When a late cancellation fires (via the cancel link OR by staff in the
app):

1. Check `late_cancellation_waiver_used` on the client.
2. If false (first offense): set it true, skip the charge, note the waiver
   in the cancellation email ("Your first late cancellation has been waived
   as a courtesy. Future late cancellations will incur a $50 fee.").
3. If true: check for a card on file.
   a. Card exists: charge $50 via Stripe (the existing charge-card-on-file
   route), write a ledger row (negative, kind = `late_cancellation_fee`),
   note the charge in the cancellation email.
   b. No card: proceed with cancellation, notify staff, note in the email
   that the fee could not be charged.

The fee charge follows the existing money-moves-first rule: Stripe charge
succeeds, then ledger row is written. A failed charge does not block the
cancellation — the appointment is cancelled regardless; the fee collection
is a separate concern.

### Staff-initiated cancellations

The same fee logic applies when staff cancel on behalf of a client within
the window. The staff cancel flow in the app should:

- Show the policy warning ("This appointment is within 24 hours. A $50
  fee applies unless this is the client's first late cancellation."),
- Show the client's waiver status,
- Offer an override (staff can waive the fee manually, with a reason —
  a `fee_override_reason` logged on the cancellation).

## The data model additions

### On `clients`

- `communication_channel`: text, default 'email', check ('email', 'sms',
  'both'). The HOW field.
- `communication_opted_in`: boolean, default true. Covers non-transactional
  communications (birthday, follow-up).
- `late_cancellation_waiver_used`: boolean, default false. The lifetime
  waiver flag. Set to true the first time a late cancellation is forgiven;
  never reset.
- `date_of_birth`: already exists. Used by the birthday job (match on
  month + day, not year).

### New tables

- `cancellation_tokens`: (id uuid pk, appointment_id uuid fk, expires_at
  timestamptz, used_at timestamptz nullable, created_at timestamptz).
  One per appointment, created at booking, used at cancellation.
- `communications_sent`: (id uuid pk, appointment_id uuid fk nullable,
  client_id uuid fk, kind text, channel text, sent_at timestamptz,
  metadata jsonb). Prevents double-sends; audit trail. Kind values:
  'confirmation', 'day_before_reminder', 'intake_reminder',
  'cancellation_notice', 'post_visit_followup', 'birthday'.

## Build order (phases)

### Phase 1 — data model + preferences UI

Migration: the three new `clients` columns, `cancellation_tokens`,
`communications_sent`. The communication-preferences section on the client
profile page (channel + opted-in, visible/editable by staff). No emails
yet — the fields land first so they can be set on existing clients before
the communications start firing.

### Phase 2 — booking confirmation

Extend `POST /api/appointments` to send the confirmation email on success
(reusing the Resend/email pattern) and create a `cancellation_token` for
the appointment. The cancel link in the email points at `/cancel/<token>`
(a stub at this phase — the page exists but shows "coming soon" or similar
until phase 4).

[VERIFIED — phase 1 assumption check] When creating the
`cancellation_tokens` row and the `communications_sent` row in the booking
route, use `service.organization_id` — the catalog row is already in scope
at the point where both writes happen, and it is the same source the
appointment insert itself trusts. This is the house pattern for
service-role writes: explicit org id from a parent row, never
`current_org_id()` (which returns null under the service role because
there is no JWT). The `not null` constraint on both new tables is the
guard that catches a writer forgetting this.

### Phase 3 — the scheduled jobs (day-before, intake reminder,

post-visit follow-up, birthday)
The pg_cron job(s), the `communications_sent` dedup check, and the four
time-triggered emails. Verify each in both directions (sent when it should
be, not sent when already sent or opted out).

### Phase 4 — the cancel-via-link action + fee engine

The public `/cancel/<token>` page, the server route, the fee policy
enforcement (waiver check → charge or skip → ledger → email).
Also: staff-initiated cancellation UI update (policy warning, waiver
status, override reason). Verify: token single-use, window correctly
applied, waiver consumed on first use, $50 charged on second, no-card
case handled, money-moves-first.

### Phase 5 — staff-side visibility

Communication history on the client profile ("last contacted: X, about Y")
from the `communications_sent` log. Waiver status visible on the client
profile. Staff can manually trigger a resend (e.g., the client didn't
receive the confirmation).

## Must-not-break (existing scars)

- The appointment booking route (POST /api/appointments) — phase 2 adds
  to it. The `requires_intake` gate, the exclusion-constraint conflict
  check (23P01), the room pre-check, the audit log — all untouched.
  Email send is best-effort (a failed Resend call never fails the booking,
  same as the form-link send pattern).
- The §6 form-link machinery — the intake reminder reuses it. Do not
  reimplement tokenized form link delivery.
- The Stripe/ledger money pattern — the fee engine is a new caller of the
  existing charge-card and ledger-write machinery, not a new implementation.
  Money moves first.
- pg_cron: the existing purge jobs stay untouched. New communication jobs
  are additive entries.

## Deferred / out of scope for this build

- **SMS delivery** — the channel field lands now; the Twilio integration
  and TCPA-compliant opt-in are their own phase.
- **Two-way communication** (client replies to an email) — a future
  integration if wanted.
- **Rebook prompt content** — the post-visit follow-up email exists but
  the "rebook" CTA depends on the public portal having a booking flow.
  The email is sent; the CTA links to a placeholder until the portal
  has the booking UI.
- **Review request** — similarly deferred until there is a review surface
  to link to.
- **Email template design** — Resend templates or inline HTML; the content
  and styling are an owner decision (the spa's voice and branding). This
  design specifies the CONTENT (what each email says) not the DESIGN
  (how it looks).

## Relationship to other docs

- `docs/design/prospective-onboarding-design.md` — the §6 form-link
  machinery the intake reminder reuses.
- `docs/deployment.md` — the communication jobs run in pg_cron (Supabase-
  side, deployment-independent, like the retention purges).
- `docs/TODO.md` — the cancellation-fee engine moves from queued to
  in-progress when this build starts; it is the queued item whose enabler
  (card on file) has been live since §7.
- `architecture.md` — no new doors; all communication sends go through the
  existing server-route → Resend path (door 2). The cancel link's public
  route is a new Door 0 path (tokenized, no account, service-role write)
  — add it to the diagram when built, alongside the intake form and lead
  capture endpoints.
