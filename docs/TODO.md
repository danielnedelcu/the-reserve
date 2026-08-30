# The Reserve — live board

Last updated: 2026-08-30. This is the working state of the project — what's
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
   the gate to the business, not an upsell.
2. Intake forms (§6) — design draft exists; closes the booking route's
   requires_intake TODO. Matters more in a members-only club (waivers).
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

## Blocked on the owner

- Membership tier definitions — the 11-question sheet in
  memberships-notes.md
