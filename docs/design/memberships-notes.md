# Memberships (§3) — pre-design notes

Status: design session NOT yet held — blocked on owner answers below.
This file is the session's starting point when answers arrive.

## The defining constraint (captured 2026-08-29)

**The Reserve is a members-only facility.** No one enters or uses the
facility without a membership — including walk-ups, who are membered
clients not yet attached to a transaction. Membership is therefore the
GATE to the business (country-club model), not a revenue product bolted
onto a drop-in spa (Massage Envy model).

Implications to design around:

- Membership state (active/paused/past_due/lapsed) becomes an
  access/eligibility check — booking and possibly checkout should care.
- The "walk-in / no client" checkout concept inverts: anonymous sales
  become the rare exception (member's guest buying retail?) or disappear.
  Do not invest further in walk-in flows meanwhile.
- The dunning question gains a front-desk dimension: what happens when a
  lapsed member is standing at the desk?
- Gift cards create a tension to resolve: can a non-member redeem one?

## Questions for the owner

1. What is the monthly fee actually buying? Facility access (club model)?
   Included services (e.g., a massage every month)? A discount on
   everything? Some combination?
2. What does a tier look like, concretely? How many levels, rough price
   points, what differs between them? (Placeholders fine — structure is
   what the schema needs.)
3. If tiers include services ("credits"): does an unused month bank?
   Expire / roll over forever while active / cap at N?
4. Is the included service a specific thing or a value? ("One 60-min
   massage" vs "any service up to $150")
5. Can members pause? Limits? Does a paused month earn the included
   service? (Typical: pause allowed, nothing accrues.)
6. On cancellation, does access run to the end of the paid period?
   (Almost always yes — confirm.)
7. Card fails and retries don't recover — what happens at the door?
   Grace period? Immediate lapse? Front desk collects on the spot?
8. How does someone BECOME a member? Same-day signup at the desk?
   Application/approval? Founding-member arrangements to honor?
9. Guests: allowed? Fee? Member's benefits? Own waiver?
10. Is there ANYONE who enters without a membership? (Trials, day passes,
    gift-card recipients, retail pickup?) — deliberate double-check;
    "no exceptions" is hard to soften once in schema.
11. Anything already promised to existing members? Legacy pricing, verbal
    arrangements, comped memberships to grandfather.

## Engineering decisions provisionally ratified (pending no surprises above)

- **Billing engine: Stripe Subscriptions** (not self-billed pg_cron).
  Stripe owns schedule/retries/dunning/proration; invoice webhooks report.
  The 4b webhook infrastructure exists for exactly this.
- **Dues hit the ledger**: each invoice.paid webhook writes a ledger
  transaction (item kind membership_fee, payment stripe_card with the
  invoice's intent id) — membership revenue flows through existing
  financial rollups. NOTE: this is a deliberate exception to 4b's
  sync-only ledger-write rule; the webhook becomes a ledger writer for
  this one kind. Ratify consciously in the design session.
- **Enrollment: front-desk only** (client profile → enroll → tier pick →
  requires card on file, which 4b makes a prerequisite check, not a build).
- Catalog-vs-instance pattern applies: membership_tiers (catalog, like
  services) vs memberships (instances, like appointments).
- Credits, if they exist, are a LIABILITY (like gift cards) — the
  gift-card accounting machinery generalizes.

## Rails already built (4b)

Stripe customer per client (lazy) · saved cards with schema-enforced
consent · webhook route with signature verification + idempotency ·
stripe_card ledger tender · refund-to-card. Subscriptions bolt onto these.
