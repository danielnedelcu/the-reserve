# Multi-Tenancy Status — The Reserve

_Last updated: 2026-10-08 (post policy sweep, audit_log organisation and
the ledger's own organisation column). Update when tenancy-relevant
decisions are made._

## Intent

The app serves one wellness center today but was designed from migration 1 to
support multiple centers eventually. Two distinct futures use the word
"multi-location," and they require different work:

- **(a) Same company, more cities** — one organization, many locations.
  Mostly _location-layer_ work.
- **(b) Separate businesses on the platform (SaaS)** — many organizations.
  Mostly _organization-layer_ work.

The foundation supports both; the application layer has known, deliberate
single-site shortcuts, inventoried below.

---

## What is genuinely multi-tenant today (expensive-to-retrofit layer: DONE)

| Area                                    | Status                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization_id` on every domain table | ✅ From migration 1 through the POS ledger (products, gift_cards, transactions, notifications, all scheduling tables). Since 2026-10-08 the ledger's `transaction_items` and `payments` carry their OWN column, kept equal to the transaction's by a composite foreign key (they used to reach it through the transaction, per row), and `audit_log` carries it too (backfilled from the entity each row records, else its actor; its policy scopes on it — before that any holder of `audit_log.view` could read every organisation's audit rows). Join rows and participants still scope through their parent |
| RLS scoped through `current_org_id()`   | ✅ Every policy, with the helper calls wrapped as `(select …)` so they run once per query (`verify:policies` in CI; the four correlated `is_conversation_participant` calls are the only exceptions). Two orgs in this database today could not see each other's data — proven by two-organisation cases in `verify:tables`, `verify:presets`, `verify:audit` and `verify:messages` with real sessions — isolation is enforced, not aspirational |
| Roles & permissions as per-org DATA     | ✅ Each org can diverge its permission matrix without code changes                                                                              |
| `locations` table                       | ✅ With per-location `timezone` and `tax_rate_bps` — the two things that genuinely differ by city                                               |
| Staff, invites, notifications, audit    | ✅ All org-anchored; the audit log and the ledger are append-only for every role (one shared block trigger, TRUNCATE revoked from the service role) |
| Auth → staff linkage                    | ✅ `staff.user_id`; `current_staff_id()` / `current_org_id()` resolve per-session                                                               |

**The standing rule that keeps this true:** every new table gets
`organization_id` + org-scoped RLS, no exceptions. (Honored by 4a; applies to
4b/Stripe, intake forms, memberships.)

---

## Known single-site shortcuts (cheap-to-fix layer: DEFERRED)

The recurring pattern is `.limit(1)` — "fetch THE location / THE organization."
Grep for `limit(1)` to find them all. Known sites:

1. **Checkout route** — tax lookup fetches first location
2. **Rooms page** — location for resource inserts
3. **Business settings page** — edits first org + first location
4. **Staff profile** — availability-rule inserts use first location
5. **Booking/slot machinery** — implicit single location
6. **Financials** — no per-location slicing
7. **Dashboard widgets** — org-wide implicitly

Additional gaps beyond `.limit(1)`:

- **No org provisioning flow.** Orgs + their four roles + permission grants
  were created by hand in migration 1. A second business needs a
  `provision_organization()` function: create org → seed roles →
  seed role_permissions → create first location → mint first admin invite.
- **Staff are not linked to locations.** Multi-city needs a `staff_locations`
  join table; slot search and the schedule become location-aware.
- **No location context in the UI.** Schedule, checkout, financials, rooms
  would need a location picker (or per-user default location).
- **Branding is baked in.** "The Reserve" appears in: email templates
  (`server/utils/emailTemplates.ts`), receipt print HTML, sidebar brand block,
  login/invite/password pages, `MAIL_FROM`. SaaS future needs per-org branding
  (name, logo, sender identity/domain per tenant in Resend).
- **Env-level singletons.** One Supabase project, one Resend domain, one
  SMTP sender — fine for (a), needs thought for (b).

---

## Work estimate when a second center is real

**Future (a) — second city, same company:**

- `staff_locations` join + location-aware slot search
- Location picker in schedule/checkout; per-location financials slicing
- Audit every `.limit(1)` → explicit location context
- Rough size: a focused week or two. No schema surgery.

**Future (b) — second business (SaaS):**

- Everything in (a) where relevant, plus:
- `provision_organization()` + an onboarding surface
- Per-org branding + per-org email sender (Resend domain per tenant or
  shared-domain sender names)
- `.limit(1)` audit becomes org-context audit (mostly already correct via
  `current_org_id()`; the limit(1)s are location-level)
- Platform concerns: tenant billing, support access model, backups per tenant
- Rough size: several weeks. Still no schema rewrite — the org layer exists.

---

## Decision log

- **Aug 2026:** Reviewed post-4a. Verdict: change nothing now. The
  brutal-to-retrofit discipline (org_id + RLS everywhere, tax/timezone on
  locations) is maintained on every migration; the shortcuts are grep-able
  and deferred deliberately. Building pickers/provisioning for hypothetical
  tenants = gold-plating the wrong things.
- **2026-10-08 (policy sweep, docs/design/policy-sweep-design.md):** one
  isolation hole found and closed — `audit_log` had no organisation
  column, so its read policy was the permission alone; it now carries the
  column and scopes on it. Every policy's helpers evaluate once per query
  (a performance change with the same truth value, guarded by
  `verify:policies` in CI). The ledger's lines and payments carry their
  own organisation, kept equal to the transaction's by a composite
  foreign key. The rule for the next child table: scope through the
  parent unless it is read at volume, then carry the column with the key.
