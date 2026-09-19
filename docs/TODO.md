# The Reserve — live board

Last updated: 2026-09-18. This is the working state of the project — what's
done, what's queued, what's blocked on whom. Update when the board changes.

## Phase status

DONE: §1 auth/staff/roles · §2 clients · §4 catalog · rooms · §5 scheduling ·
notifications · settings · theming · email (Resend) · docs pipeline (tbls) ·
§10–11 financials + dashboards · §9 messaging · §7 POS & payments
(migration 4a: ledger/checkout/refunds/gift cards/tax/receipts/audit —
gauntlet-verified; migration 4b: Stripe card-on-file with consent, charging,
refund-to-card, card removal, webhook — mini-gauntlet-verified, test mode) ·
§6 form engine + prospective onboarding THROUGH `approved` (2026-09-06/07,
detail below; the enroll → activate tail is QUEUED item 2, not done).

### §6 — what shipped, as the code shows it (2026-09-06 → 07)

Four migrations, all applied to the hosted DB: `form_engine`,
`form_links_and_public_submission`, `prospect_review_and_retention`,
`waiver_health_promotion`. Commits 219fa71 · 8b5a8d2 · 08baa4d · 1405867.

- **Engine.** `form_definitions` + immutable `form_versions` (fields jsonb
  carries `required` and `sensitive`); `form_responses` (non-health) split
  from `form_response_health` (gated by `clients.notes.health.view`);
  `prospect_intake` created at submit; `form_links` (single-use token,
  frozen `form_version_id`); `form_submission_attempts` (HMAC'd IPs,
  `FORM_IP_PEPPER`, fail-closed). Anon holds no write path anywhere — the
  submit RPC is service-role only with execute revoked.
- **Public submission.** `GET/POST /api/public/forms/:token`; page at
  `/join/:token` (moved off `/forms/**` before shipping so the auth
  exclude covers public pages only). Zod schema on the client is DERIVED
  from the shared field contract, and `tests/shared/formValidation.test.ts`
  asserts it agrees with the server's `validateAnswers` at the edges.
  Yes/No radios for boolean questions, neither preselected.
- **Review UI, through `approved`.** `/intake` list + `/intake/:id`;
  `submitted → under_review → approved | rejected` via
  `POST /api/prospects/:id/review`. Health answers are never fetched by
  the detail route — structural, not a permission doing the work.
  AS-BUILT DEVIATION from the design's seam note: the "stub `active` as
  create-a-client" was deliberately NOT built (08baa4d). Approve records a
  decision and creates nothing; there is no activate path at all. The
  end-to-end testability the stub was for came from the harnesses instead.
- **Retention.** 30 days for `prospect_intake` (allowlisted statuses, so a
  future `enrolled` is kept by omission), 24 hours for
  `form_submission_attempts`; both on pg_cron, scheduled in the migration.
  `verify:forms` asserts the OUTCOME (nothing past either window), since
  the app's roles cannot read `cron.job`.
- **Form builder.** `/forms`: create from seeded templates (`prospect_intake`,
  `service_waiver`), question editor (add / remove / reorder /
  edit; keys of already-answered questions are never re-keyed), publish
  the NEXT version — published versions never change.
- **Sending.** `POST /api/forms/:key/links` emails the link via Resend
  (best-effort; a failed send never fails issuance, and the dialog says
  which happened). Send dialog carries a client picker, so an
  existing-client waiver is addressable at all — before this every waiver
  attempt 422'd.
- **Existing-client waivers.** Health answers promoted into
  `client_notes(kind=health)` on submit — APPEND, one dated,
  version-stamped note per answer per submission — so they land in the
  tier whose reads are audited (`health_note.viewed`, now with a non-null
  `actor_user_id`). Client page shows "Completed forms" as provenance
  only, no health content. Multiselect answers promote as a joined string
  (the element-0 bug was caught and fixed in verification).
- **`requires_intake` booking gate.** `POST /api/appointments` reads the
  service flag and, under service role, requires ANY completed waiver in
  `form_responses` for that client; refuses with `needsIntake: true`
  otherwise. This was §6's original scope; the "requires_intake TODO" is
  closed. (Version-exact gating was considered and rejected — see design
  decision 12.)
- **Harnesses.** `verify:forms` 40/40 (anon write paths, health split,
  purge in both directions, retention canary); `e2e:forms` 14/14 (token
  single-use, rate limit limits, over HTTP). Both in package.json.
- **UI consistency, first two batches (60f15e3 · 001df8c · c564393).**
  `forms/index.vue`: answer-type `<select>` → `UiSelect` with a guarded
  setter, template-card disabled tokens, cards side-by-side from `md`.
  Then every remaining staff-page `<select>` → `UiSelect`: schedule ×3,
  services ×1, staff/[id] ×2 (the numeric day-of-week one bridged with a
  `String()`/`Number()` computed and its type round-trip proved). The one
  `<select>` left in `app/` is `JoinFormField.vue` — deliberate native,
  public page, commented as such.

NOT done, and not claimed: enroll → activate (below); Ask's allowlist is
NOT extended to the forms tables (open question in architecture.md; the
health tables are permanently excluded regardless); the pre-launch pepper
item still stands.

QUEUED (in order):

1. Memberships (§3) — BLOCKED on owner answers (see memberships-notes.md).
   Stripe Subscriptions on the 4b rails; unlocks the dashboard Members card.
   KEY CONSTRAINT: The Reserve is a MEMBERS-ONLY facility — membership is
   the gate to the business, not an upsell. Owns the enrolled → active half
   of the front door; item 2 owns the half before it, and Q8 is shared.
2. Onboarding ENROLL → ACTIVATE tail (§6, the half after `approved`) —
   OWNER-BLOCKED, moves with §3. Everything before it shipped (see §6
   block above). What remains is exactly: the `enrolled` / `active`
   states on `prospect_intake`, the enrollment action (tier + card on
   file, at the desk, with the person present), and client creation as
   its consequence. Shares owner question 8 with memberships.
   Do NOT build this on guesses about tiers, and do NOT add a
   "create client" button to the review page in the meantime — the route
   and page comments say why (08baa4d). When `enrolled` is added, the
   purge's status allowlist already keeps it.
3. Cancellation-fee engine — its enabler (consented card on file) is live.
4. Marketing (§8) — LEAD CAPTURE DONE 2026-09-13 → 09-18, all four
   phases (docs/design/leads-design.md): `leads` + `lead_notes` schema
   with the allowlist purge; the OPEN public capture endpoint
   (`POST /api/public/leads`, honeypot + per-IP limit + exact-origin CORS,
   org and origins as fail-closed config); the staff UI (`/leads`,
   `/leads/:id`, notes, status control) with the arrival-alert nav dot
   and bell; and conversion — "send intake form" issues the §6 link
   through `convert_lead()` in one transaction and threads
   `prospect_intake.lead_id` at submit. `verify:leads` 72/72. What
   remains of §8 beyond lead capture (campaigns, marketing consent
   policy, landing pages themselves — which live on the marketing site)
   is not designed. Known residuals recorded in the design doc:
   per-IP limiting is evaded by distributed bots (CAPTCHA is the
   escalation, keyed to observed abuse); the marketing-consent POLICY is
   owner/legal-adjacent, the columns are ready for it.
5. UI polish sprint — after feature phases (see ui-polish.md).

## Punch list (small, unblocked, any-session)

- LATENT CORRECTNESS BUG, fix deliberately, NOT in the scheduler reskin:
  the two-timezone seam. The schedule grid positions appointments and
  builds its day range from the VIEWER'S browser clock
  (app/pages/schedule.vue `blockStyle`, `fetchRange`), while the slots
  route computes availability in the LOCATION'S timezone
  (server/api/appointments/slots.get.ts, `localToUtc`). They agree only
  while viewer and location share a zone — true today, one city. Found by
  the scheduler behaviour inventory 2026-09-19; commented as a scar at
  both ends. The fix moves the grid onto the location's zone (the slots
  side is right); it needs its own verification across a DST boundary and
  a viewer in another zone, which is why it is not folded into a visual
  change.

- KPI cards — permission gate discrepancy (owed since the dashboard
  shipped): the booking counts in app/components/dashboard/KpiCards.vue
  ("Appointments (7 days)", "Booked ahead", no-show rate) have no
  `can()` gate and rely on appointments RLS, so a viewer limited to
  appointments.view.own sees their OWN counts presented as the club's.
  The bookings chart (2026-09-19) gates on appointments.view.any for
  exactly that reason; the cards should match, or say "yours" when the
  viewer is own-only.
- KPI cards — trend-floor consistency (found 2026-09-19 with the chart
  floor): counts now use the shared app/utils/trend.ts baseline
  (TREND_MIN_BASELINE = 10 in the previous period). The no-show and
  revenue cards call the same function but pass `minBaseline: 1` — a
  DOCUMENTED PLACEHOLDER that preserves their pre-floor behaviour, not
  a floor. The real fix, per card:
  - No-show rate: the trend compares two RATES (percent), so the
    denominator that matters is the SAMPLE SIZE under each rate, not
    the prior rate's value. Floor on the prior window's booked count
    (the `total` inside `noShowRate`), e.g. ≥ 10 booked appointments in
    the prior 7 days, else no trend; the prior rate itself may be small
    and still be a perfectly good baseline. Needs `apptMetrics` to
    expose the prior window's count alongside the rate.
  - Revenue: the trend compares two CENT totals, so the floor is a
    DOLLAR AMOUNT on the prior week, e.g. ≥ $100 (10_000 cents) of
    service + retail, else no trend; a $12 prior week makes any normal
    week a 500% "surge". Pass it as `minBaseline` in cents.
  Either way the placeholder `minBaseline: 1` goes away, and the card
  comment in KpiCards.vue that points here comes out with it.
- requirePermission helper adoption in checkout + refund routes
  (server/utils/requireUser.ts:23 does auth+permission in one call)
- receiptEmail return-shape consistency ({subject,html} object like the
  other templates; route destructures)
- Message thread pagination — designed, not built: keyset desc limit 50
  reversed, scroll-top older-page fetch with scrollHeight-delta
  preservation, dedupe by id. Current loadThread loads OLDEST 200 —
  latent bug at volume.
- Tax on discounted base (GA taxes the discounted price; current math
  taxes pre-discount — matters only for discounted taxable retail)
- /settings title field: DB trigger blocks provider self-edit; settings
  form may need title shown read-only (unverified)
- Duplicate-card guard: refuse/reuse on Stripe card.fingerprint match
- Card-consent policy text → business settings page (hardcoded const in
  ClientCards.vue, TODO(business-settings) marks it)
- Checkout route single-DB-transaction hardening (writes are sequential
  inserts; an RPC wrapping them in one tx is the robust form)
- Remaining confirm() → themed dialogs: staff deactivate, invite revoke,
  availability deletes (opportunistic, when touching those files)
- Held/parked tickets (resumable carts) — only if the spa asks; lives
  OUTSIDE the ledger
- ~~audit_log.actor_user_id NULL across health_note.viewed /
  appointment.booked / pos.checkout~~ DONE 2026-09-06. Normalized once as
  `actorUserId()` in server/utils/requireUser.ts and applied to all four
  writers (health-notes, appointments, checkout, prospect review).
  Verified live: health_note.viewed now records a non-null actor_user_id.
  Found again, not by looking for it — an assertion that reading a
  promoted health note fires its audit surfaced the NULL on the very row
  being cited as proof of the audit invariant. Historic rows keep their
  NULLs; actor_staff_id was always populated, so nothing was untraceable.

## Pre-launch checklist

- Rotate Resend API key and DB password (exposed in chat during dev;
  Supabase service key already rotated after the push-protection catch)
- FORM_IP_PEPPER must be set in the production environment, and it is a
  DIFFERENT value per environment. It keys the HMAC over visitor IPs on
  the public intake form, so rotating it re-anonymises history: existing
  form_submission_attempts rows stop matching new hashes, which resets
  rate-limit counters rather than corrupting anything. Absent, the public
  submission route refuses to serve — fail-closed on purpose, so a missing
  secret shows up as an outage, not as silently weaker hashing.
- Production Stripe webhook endpoint registration (dashboard) — the CLI
  whsec\_ is dev-only; prod gets its own signing secret
- Live Stripe keys swap + a small real-money verification pass
- Enable GitHub Secret Scanning on the repo (offered; one click)
- CI: GitHub Action running nuxt typecheck + vitest on PRs (before the
  backend engineer's first PR)

## Verification debts (runtime checks owed)

- StaffEditSheet Roles section: confirm roles list renders + pre-checks +
  save works (after the description-column fix AND the toggle-set
  migration)
- Ask: verify the prompt cache is actually hitting. There are TWO cached
  prefixes now, not one — the system block (the schema, byte-identical on
  every ask) and the last prior-turn message (the conversation so far).
  Both have to hold, and the older baseline below could only see one of
  them. Check after a handful of real asks, before the cost normalises as
  "just what it costs":

      select created_at, thread_id, input_tokens, cache_read_tokens,
             cache_write_tokens, cost_micros
        from ask_queries where model is not null
       order by created_at desc limit 10;

  BASELINE 2026-09-05 (post-threading). What healthy looks like:

      first ask, cold window   cache_read=0             cache_write≈3218
      first ask of a thread    cache_read≈3218          cache_write=0
      follow-up, turn 2        cache_read≈3218          cache_write≈50–250
      follow-up, turn 3+       cache_read≈3400–3700+    cache_write≈50–250

  Read it as a shape, not a number. cache_read GROWS with thread depth —
  schema plus every prior turn — and cache_write COLLAPSES to the size of
  the one new turn once the schema has been written. A deep thread reads
  well past 3700; that is the system working, not drift.

  The failure the old baseline would have called healthy: a follow-up
  (same thread_id, not the first row for it) reading ~3218 and nothing
  more. That is the schema cache hitting while the conversation prefix
  misses — context caching is broken, every turn resends its predecessors
  at full rate, and thread cost goes O(n²) in depth. Against the old
  schema-only figure of 3218 that reads as a perfect hit, which is exactly
  why this entry was rewritten. Judge cache_read against the thread's
  depth, never against a fixed number.

  The other failures:

  - Zeros all the way down — nothing is caching, bill roughly 4.6x.
    Likeliest causes: the system prompt rebuilt per request, cache_control
    dropped, or something volatile creeping in ahead of a breakpoint.
  - A zero on the first ask of a cold window is expected, not a bug.
  - A thread past CONTEXT_DEPTH (20) legitimately loses the conversation
    prefix: the window slides, the oldest turn drops off, and the prefix
    changes every turn. Verified, not assumed — check depth before
    calling it a bug.

  SUPERSEDED baseline, pre-threading (single breakpoint, schema only), kept
  because it is what the numbers above are measured against:

      ask 1 (cold): in=225 out=78 cache_read=0    cache_write=3218  $0.0232
      ask 2 (warm): in=225 out=89 cache_read=3218 cache_write=0     $0.0050

## Blocked on the owner

- Membership tier definitions — the 12-question sheet in
  memberships-notes.md (Q12 added 2026-09-06: does any path to clienthood
  bypass membership enrollment? Blocks the "Add client" button's fate.
  NARROWED the same day: approval and enrollment are in-person only, so
  no remote path exists; what is left is the desk itself — walk-ins with
  no form, plus the Q9/Q11 guest and comp cases)
- The §6 enroll → activate tail (QUEUED item 2) waits on the same sheet.
