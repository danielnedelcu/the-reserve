# The Reserve — live board

Last updated: 2026-09-06. This is the working state of the project — what's
done, what's queued, what's blocked on whom. Update when the board changes.

## Phase status

DONE: §1 auth/staff/roles · §2 clients · §4 catalog · rooms · §5 scheduling ·
notifications · settings · theming · email (Resend) · docs pipeline (tbls) ·
§10–11 financials + dashboards · §9 messaging · §7 POS & payments
(migration 4a: ledger/checkout/refunds/gift cards/tax/receipts/audit —
gauntlet-verified; migration 4b: Stripe card-on-file with consent, charging,
refund-to-card, card removal, webhook — mini-gauntlet-verified, test mode).

QUEUED (in order):

1. Memberships (§3) — BLOCKED on owner answers (see memberships-notes.md).
   Stripe Subscriptions on the 4b rails; unlocks the dashboard Members card.
   KEY CONSTRAINT: The Reserve is a MEMBERS-ONLY facility — membership is
   the gate to the business, not an upsell. Owns the enrolled → active half
   of the front door; item 2 owns the half before it, and Q8 is shared.
2. Prospective-member onboarding + intake forms (§6) — the members-only
   FRONT DOOR. Designed 2026-09-06, prospective-onboarding-design.md (this
   supersedes "design draft exists" — there is a design). It splits across
   two phases, and the split is the point:

   - §6 FORM ENGINE — BUILDABLE NOW, no owner input needed: form
     definitions + versioning, response storage, prospect_intake table,
     tokenized link delivery, the public token-gated submission endpoint,
     the staff review UI, 30-day retention purge. The same engine serves
     existing-client waivers and closes the booking route's
     requires_intake TODO — building it for prospects does not defer §6's
     original scope, it delivers it.
   - ENROLL → ACTIVATE — OWNER-BLOCKED, moves with §3: what a paid
     membership grants, tiers, the moment a prospect becomes a member.
     Shares owner question 8 with memberships.

   THE SEAM: build through `approved`; stub `active` as "create a client
   with no membership" so the pipeline is end-to-end testable, then
   replace the stub when §3 lands. Do NOT build enrollment on guesses
   about tiers. Riskiest piece is the unauthenticated submit endpoint —
   the design doc flags it for the same verify-the-assumption rigor Ask
   got.
3. Cancellation-fee engine — its enabler (consented card on file) is live.
4. Marketing (§8).
5. UI polish sprint — after feature phases (see ui-polish.md).

## Punch list (small, unblocked, any-session)

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
- audit_log.actor_user_id NULL across health_note.viewed /
  appointment.booked / pos.checkout — normalize actor id resolution once
  in requireUser, fix the three remaining call sites
  (clients/[id]/health-notes.get.ts:40, appointments/index.post.ts:210,
  checkout/index.post.ts:563; /api/ask was the fourth and is already
  fixed). Cause: serverSupabaseUser() returns decoded JWT claims, where
  the id is `sub` — but is TYPED as a User, so `user.id` typechecks and
  is undefined at runtime. actor_staff_id is populated on every row, so
  nothing is untraceable. Write-up + fix pattern in
  docs/design/ask-the-reserve-design.md (Verification, [AS-BUILT]).

## Pre-launch checklist

- Rotate Resend API key and DB password (exposed in chat during dev;
  Supabase service key already rotated after the push-protection catch)
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

- Membership tier definitions — the 11-question sheet in
  memberships-notes.md
