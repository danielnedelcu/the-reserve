# Testing reference — how Lokl tests against a local stack and a browser

Read 2026-10-05 from `~/turbo` (the Lokl marketplace, HEAD `009afe9`),
read-only, as the foundation for two pieces of The Reserve work: the CI
local Supabase stack that closes the board's "dedicated CI Supabase
project" item, and a Playwright end-to-end suite. Companion to
`docs/turborepo-reference.md`. Lokl and The Reserve share no accounts,
keys or code; this document copies SHAPES, never values.

This is a dated reading of another codebase; what The Reserve then built
from it is in `docs/testing-design.md` (as-built sections), and that doc
is the one to trust for which harness runs where. In particular, since
2026-10-08 The Reserve's harnesses that create staff or write ledger or
audit rows run on the local stack ONLY (a hosted run skips or refuses),
and a unit test fails CI on any workflow step that runs one without
`SUPABASE_LOCAL=true`.

Lokl's testing has four layers, and the layer a check lives in is chosen
by WHERE THE RULE LIVES:

| Layer | Where it runs | What it proves | Lokl's command |
| --- | --- | --- | --- |
| pgTAP (27 files) | inside Postgres, one transaction per file, rolled back | access rules: every policy's allowed AND blocked case | `npm run db:test` |
| App harnesses (15 `.mts` files) | `tsx` scripts against the local stack, importing the apps' own server code | route-level rules that need the server code: leak checks, booking state machines, jobs, emails | `npm run db:test:app:core` / `:stripe` |
| Realtime (3 files) | `tsx`/node against the local stack's Realtime | live delivery scoped by RLS | `npm run db:test:realtime` |
| Playwright (11 journeys) | Chromium against BUILT aapps on 3200/3201 and the local stack | the person's reachable path, end to end | `npm run test:e2e` |

Plus `test:ui` (seven `tsx`-run unit tests of pure UI logic) and
`test:emails` (template snapshots), both with no services.

## 1. The CI local Supabase stack

### The workflow, job by job

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request to `main`, one run per branch (`concurrency` cancels an older
run), `permissions: contents: read`. Four jobs:

| Job | Secrets | Steps |
| --- | --- | --- |
| `checks` | none | `npm ci`, typecheck, `test:ui`, `test:emails`, `tsc -p e2e` (the e2e tests are type-checked even when they do not run) |
| `database` | none | `npm ci`, `supabase/setup-cli@v1` pinned to `2.118.0`, `supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor`, `db:test` (pgTAP), `build:check`, `scripts/ci-start-apps.mjs`, `db:test:app:core`, `db:test:realtime`; on failure, the last 200 lines of each app's server log |
| `stripe` | `STRIPE_SANDBOX_SECRET_KEY` from the `stripe-sandbox` environment | same stack, then `db:test:app:stripe` |
| `e2e` | same key | same stack, Playwright Chromium installed with `--with-deps`, `test:e2e`; on failure, traces and screenshots uploaded for seven days |

The pieces that make the `database` job work with no secrets:

- **The stack is the CLI's.** `supabase start` boots Postgres, Auth,
  PostgREST, Realtime, Storage and Mailpit in the runner from
  `supabase/config.toml`. The `-x` list leaves out Studio and the other
  services the tests never touch, for a faster start.
- **Keys are read at run time, never stored.** Every script and test
  reads `supabase status -o env` and takes `API_URL`,
  `PUBLISHABLE_KEY`/`ANON_KEY`, `SERVICE_ROLE_KEY`/`SECRET_KEY`,
  `DB_URL` and `MAILPIT_URL` from it. These are the CLI's fixed local
  values. Nothing is printed.
- **Every script refuses anything but localhost.** `env.ts`,
  `ci-start-apps.mjs` and each app harness test
  `/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/` against the API URL
  and exit if it fails. A misconfigured laptop cannot point a
  destructive harness at the hosted project.
- **Migrations are the schema.** `db:test` is `supabase db start &&
  supabase db reset --local && supabase test db`: rebuild the local
  database from `supabase/migrations/` from scratch, then run pgTAP.
  There is no `seed.sql`; the reference rows tests rely on (the Atlanta
  city row) are inserted by the migrations themselves, so a fresh
  database is a complete one.
- **The apps are built, not run in dev.** `build:check` builds each app
  into `.nuxt-check`/`.output-check`; `ci-start-apps.mjs` starts
  `.output-check/server/index.mjs` with `NODE_ENV=production`, detached,
  logging to `.output-check/server.log`, records the pids in
  `node_modules/.cache/ci-apps.pids`, and polls each port for up to a
  minute until any HTTP status comes back. `--stop` kills the pids.
- **The apps' env is built from the stack.** The script sets
  `NUXT_PUBLIC_SUPABASE_URL`, both keys, `NUXT_PUBLIC_SITE_URL`, email
  mode `off`, a fresh random `NUXT_JOB_SECRET` unless one is given, a
  Stripe key only if one is present and only if it is test-mode, and
  never a Stripe key for the admin app.
- **The cookie prefix is set explicitly.** `@supabase/ssr` names the
  auth cookie after the Supabase project ref at BUILD time. A build made
  on a laptop whose `.env` points at the hosted project would read every
  page as signed out against the local stack, so the script sets
  `NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX` from the local URL's hostname.
  This was a real bug, and it is the one non-obvious line in the script.
- **Teardown is the runner's.** Nothing stops the stack; the job ends
  and the VM is discarded. Locally, `supabase stop` is the person's job.

### The pgTAP layer

Each file is `begin; \ir _helpers/users.psql; select plan(N); … select *
from finish(); rollback;`. The helper creates a `tests` schema with
functions that mimic PostgREST's session: `create_user` inserts a bare
`auth.users` row; `authenticate_as(user, app_role)` sets
`request.jwt.claims` and `role` to `authenticated` for the rest of the
transaction; `authenticate_as_admin`, `authenticate_as_anon`,
`authenticate_as_service_role` and `clear_authentication` do the same
for the other roles. Because the helper runs inside the file's
transaction, everything it creates rolls back with the test, so files
never interfere and the database is clean after every run.

Test bodies read as pairs: the row count a customer sees, then the
count another customer sees; `throws_ok` with the exact SQLSTATE and
message for a signed-out visitor. Lokl's recorded discipline: a new
access-rule test is proven by breaking the rule once, watching it fail,
then restoring it.

### The app harness layer

The `.mts` files are the shape of The Reserve's `verify-*.mjs`, with
three differences:

1. They run against the LOCAL stack, never the hosted project, and
   refuse otherwise.
2. They `import` the app's server code directly
   (`../../../apps/website/server/utils/publicListings`), so the thing
   under test is the real query function with a signed-out client, not a
   re-implementation.
3. Each run tags its rows with a random 4-byte `run` id, tracks every id
   it created in a `created` object, and deletes them in a `finally`,
   in dependency order, sometimes via `psql` with
   `session_replication_role = replica` to bypass triggers that forbid
   deletes in real use.

The output convention is identical to The Reserve's: `ok  ` / `FAIL`
per check, a failure count, non-zero exit.

### Stripe, kept out of the default path

The `stripe` and `e2e` jobs run only when the `stripe-sandbox`
environment holds a key, skip with a notice otherwise, refuse any key
that is not `sk_test_`/`rk_test_`, and check at run time that the key
belongs to the one sandbox account. The key is RESTRICTED to the
permissions the five Stripe tests need (recorded in Lokl's decisions),
so a leaked CI key can only touch test-mode payments. The two jobs share
a `concurrency` group so only one touches the sandbox at a time.

## 2. The Playwright setup

### Config

`e2e/playwright.config.ts`: `testDir: ./journeys`, `fullyParallel:
false`, `workers: 1` (the journeys share the sandbox and the stack),
`retries: 0`, `timeout: 90_000`, `expect.timeout: 15_000`, baseURL
`http://localhost:3200`, `trace: retain-on-failure`, `screenshot:
only-on-failure`, list reporter locally and list plus HTML in CI. Two
projects: `desktop` (Desktop Chrome) for everything and `phone` (Pixel 7)
for tests tagged `@phone`. The browser runs in `America/Los_Angeles` ON
PURPOSE: the pages must still show Atlanta times, so a timezone bug
fails a journey. WebKit is deferred until a staging site exists over
HTTPS, because production cookies are `Secure` and WebKit refuses them
on plain-http localhost.

`e2e/tsconfig.json` is a plain ES2022/Bundler config so `tsc -p e2e`
type-checks the tests in the `checks` job without running them.

### How the apps are started

`scripts/e2e.mjs`: refuse without a test-mode Stripe key (from the
environment, or else read from the website's `.env`); build both apps
with `build:check` unless `--no-build`; start them through
`ci-start-apps.mjs` on **3200 and 3201**, never the dev servers on
3100/3101 (which point at the hosted project); run Playwright with any
extra args passed through (`-- --grep "Service"`); stop the apps in a
`finally`. `supabase/config.toml` lists the 3200/3201 `/confirm` URLs
among the auth redirect URLs so sign-in links work on the test ports.

### Test structure

`e2e/journeys/N-name.spec.ts`, numbered in the order a person would
meet them, each file one journey with one or a few `test()` calls:

1. book an Experience (desktop and `@phone`)
2. request a Service, provider accepts one time and declines another
3. cancel with a refund, by customer and by provider
4. a payout, through the real job route
5. the real sign-in once per run, through Mailpit
6–7. admin guides and dashboard
8–11. provider profiles, saved items, sign-in code boxes, reviews

Every test imports from `e2e/support/`:

- **`fixtures.ts`** extends Playwright's `test` with a `data` fixture:
  `TestData.create()` before the test, `data.cleanup()` in a `finally`
  after it, so rows are removed even when the test fails. It also
  exports `stopAtStripe(page)`, which routes `checkout.stripe.com` to a
  stub page and returns a function that waits for the navigation and
  hands back the URL the browser was sent to.
- **`env.ts`** loads the local stack's keys from `supabase status`,
  refuses a non-local URL, builds a service-role client with
  `persistSession: false`, and (for Lokl) the Stripe client with its
  sandbox checks and the run's job secret. Cached per process.
- **`auth.ts`**: sign-in without email. See below.
- **`data.ts`**: the `TestData` class. See below.
- **`mail.ts`**: reads Mailpit's API for the newest sign-in email to an
  address, extracts the six-digit code and the verify link, and drives
  the code boxes by typing or by a synthetic paste event.

Assertions are role-and-name locators (`getByRole("button", { name:
"Continue to payment" })`, `getByRole("dialog", { name: … })`,
`getByLabel("Your name")`), which doubles as an accessibility check:
a control without an accessible name cannot be found, and Lokl's
decisions record a real labelling bug the suite caught.

### Auth in tests

The decision, recorded 2026-10-04: **test users sign in by password in
the test code, and the session's cookies are given to the browser.
Nothing test-only lives in the apps.**

`signIn(context, email, password)` creates an `@supabase/ssr` server
client with an in-memory cookie jar, calls `signInWithPassword`, waits
up to half a second for the library to write its cookies, and adds them
to the Playwright `BrowserContext` for `localhost` with `SameSite=Lax`.
Because the cookies are written by the same library the apps read them
with, a format change breaks both sides together and shows as a
signed-out page rather than a quiet pass. Switching user mid-test is
`context.clearCookies()` then `signIn` again (journeys 3 and 4 do this
to act as customer, provider and admin in one test).

Test users come from `data.user(label, { admin })`:
`auth.admin.createUser` with `email_confirm: true`, a random password,
and `app_metadata: { role: "admin" }` for admins, which is Lokl's role
model. Addresses are `e2e-<label>-<run>@test.local`.

Exactly one journey uses the real emailed sign-in, through Mailpit, to
prove the email path itself; everything else uses the password
shortcut.

### Test data and cleanup

`TestData` is the whole isolation model:

- A random `run` id per test, in every email, slug and title, so two
  runs or two tests cannot collide and leftovers are identifiable.
- Builder methods (`user`, `provider`, `category`, `area`, `listing`,
  `session`, `paidBooking`, `heldRequest`, `completedBooking`, `guide`)
  write rows with the service role, push every id into a tracked list,
  and return what the test needs. Money states are made through
  Stripe's API with test payment methods (`pm_card_visa`,
  `pm_card_bypassPending`), never by paying on Stripe's page.
- Time-travel is done with `psql` against the local `DB_URL`, disabling
  the guard trigger, updating the timestamps, re-enabling it: a booking
  that "ended yesterday", a guide "updated six hours ago". Local
  database only, by construction.
- `cleanup()` deletes in dependency order: tracked guides, then a single
  `psql` statement under `session_replication_role = replica` that
  removes every child row of the tracked listings (reviews, emails,
  finances, events, bookings, sessions, photos) and then the listings,
  then provider photos from Storage, provider child rows, providers,
  auth users, areas, categories. Bookings are never deleted in real use,
  so the tests remove their own rows directly.
- `data.job(name)` calls a timed-job route with the run's secret, the
  way the scheduler would, so a journey can advance state through the
  real job code.

## 3. Patterns worth carrying into The Reserve

In order of value:

1. **The `database` job shape.** `supabase start -x …` in the runner,
   `supabase db reset --local` from `supabase/migrations/`, keys from
   `supabase status -o env`, a localhost-only guard in every script,
   nothing stored. This is the whole answer to the board's "dedicated
   CI Supabase project" item: a throwaway stack per run, no second
   hosted project, no secret in GitHub. The Reserve already has
   `supabase/config.toml` (project `TheReserve`, API 54321, site URL
   `127.0.0.1:3000`) and 30-odd migrations, so `supabase db reset`
   should already produce a complete database; the first task is to
   confirm it does and fix any migration that depended on hosted state.
2. **Point the `verify:*` harnesses at the local stack.** They already
   have the right shape (tagged rows, both directions, non-vacuous,
   `PASS`/`FAIL`, a connection failure counts as FAIL). Three changes
   make them CI-runnable: read the keys from `supabase status -o env`
   when `apps/reserve/.env` is absent or when a `--local` flag is set;
   refuse a non-local URL in that mode; and for the harnesses that need
   a running app (`verify:leads`, `e2e:forms`), start the BUILT app the
   way `ci-start-apps.mjs` does, with the cookie prefix set from the
   local URL. The `anon has no write path` checks become stronger on a
   stack whose schema came purely from migrations.
3. **Build the app for tests, in separate folders.** `build:check` plus
   a start script that runs `.output/server/index.mjs` with
   `NODE_ENV=production`, polls the port, records pids, and stops them.
   The Reserve's unit tests already time out when a dev server builds
   beside them; a built app sidesteps that entirely.
4. **The Playwright skeleton**: `e2e/` at the repo root with
   `playwright.config.ts`, `support/` and `journeys/`, `workers: 1`,
   trace and screenshot on failure, `tsc -p e2e` in the `checks` job,
   Chromium only until HTTPS exists. The Reserve's staff app is
   authenticated and invitation-only, so the `data` fixture's first
   builder is a staff member: `auth.admin.createUser` with a password,
   a `staff` row, a `staff_roles` row for the role under test, and the
   permission model is then exercised as a real person would hit it.
5. **Password sign-in in the test code, cookies handed to the browser.**
   The Reserve's login page is email and password already, and it uses
   `@nuxtjs/supabase`, so the same `@supabase/ssr` jar trick applies.
   Nothing test-only enters the app.
6. **A `TestData` class with a run id, tracked ids and dependency-order
   cleanup.** For The Reserve: clients, appointments, forms and
   responses, tokens, campaigns. The append-only ledger is the one place
   this needs care; see section 4.
7. **Timezone on purpose.** Run the browser in a zone that is not the
   location's and assert the location's times. The Reserve's scheduler
   grid used to position by the browser clock (a recorded scar), and this
   is exactly the journey that made that seam fail loudly — and then
   proved the fix (2026-10-06).
8. **Role-and-name locators as the accessibility check.** The Reserve's
   public pages already carry the accessibility rationale in comments;
   a journey through `/join/<token>` and `/cancel/<token>` that finds
   every control by role and label makes that rationale enforced.
9. **Secrets gated by environment, refused unless test-mode, one job at
   a time.** If a Stripe journey is ever added for the card-on-file
   charge, copy the `stripe-sandbox` environment, the `sk_test_`/
   `rk_test_` check, the account-id check, a restricted key, and the
   shared concurrency group.
10. **The explicit cookie prefix** for an app built on one project and
    run against another. The Reserve will hit this the first time a
    laptop build is started against the local stack.

## 4. Lokl-specific decisions that do not apply

- **Two apps, two ports, an admin app with no Stripe key.** Every
  `apps`-array loop, the `NUXT_ADMIN_ORIGIN`/`NUXT_PUBLIC_WEBSITE_URL`
  pair, and the 3200/3201 split exist because Lokl has two apps. The
  Reserve starts one app on one test port; the loop collapses to one
  entry.
- **The role model.** Lokl's admin is `app_metadata.role = "admin"` on
  the auth user, checked by `is_admin()` reading JWT claims. The
  Reserve's roles are data: `staff` → `staff_roles` → `roles` →
  `role_permissions`, with `has_permission()` and its own `is_admin()`
  reading the staff row. pgTAP's `authenticate_as(user, app_role)`
  helper would need a `staff` row created instead of an `app_metadata`
  claim, and test users need a `staff` row before any policy lets them
  see anything.
- **The Stripe sandbox machinery.** Connected accounts, transfers,
  payouts, manual-capture holds, the pay-out job, the restricted key's
  permission list and the account-id check are all Stripe Connect.
  The Reserve's Stripe is card-on-file charges from the platform's own
  account; if a journey ever charges a card, the gating pattern carries
  but none of the Connect specifics do.
- **`private.booking_records` and `session_replication_role`
  cleanups.** Lokl deletes bookings in tests because its schema forbids
  deleting them in real use. The Reserve's ledger is append-only for
  every role since 2026-10-08 (an update/delete trigger and a TRUNCATE
  revoke, ledger-integrity-design.md; before that only the absence of
  policies, which the service role bypassed); a cleanup that deletes
  `transactions` under the service role is REFUSED, and the local
  harnesses and seed remove their rows only on the direct postgres
  connection with `session_replication_role = replica`, behind the
  localhost guard. The honest shape for The Reserve is tagged
  test rows that are LEFT, as the phase 4 C2 baseline was, or a
  test-only organisation whose rows are never mixed with the real one.
  Decide this before the first money journey, not after.
- **Mailpit sign-in codes and the six-box pin input.** Lokl signs in by
  emailed code and link; the mail helper and journeys 5 and 10 test that
  UI. The Reserve signs in by password, and its emails are
  transactional (confirmations, reminders, cancellation notices,
  campaigns). Mailpit is still useful: a journey can book, then read
  the confirmation email from Mailpit's API and follow its cancel link,
  which is the one path The Reserve has that Lokl's suite never needed.
- **Lokl's data model** (cities, categories, service areas, listings,
  experience sessions, guides, reviews) and the Atlanta reference row
  the migrations seed. None of it maps; The Reserve's equivalents are
  organisations, locations, staff, services, clients and appointments,
  and its migrations seed roles and permissions rather than a market.
- **Realtime tests.** Lokl tests Realtime delivery of notifications
  scoped by RLS. The Reserve has messaging and notifications on
  Realtime too, so the layer applies, but Lokl's three files test
  Lokl's tables and would be rewritten, not ported.
- **`test:ui` and `test:emails` as `tsx` one-offs.** The Reserve has a
  256-test Vitest suite in the `nuxt` environment; it already covers
  what those two scripts do for Lokl, and stays as it is.

## What a first slice would be

Left for the design, not decided here: the smallest CI change with
real value is a `database` job that starts the stack, runs `supabase db
reset --local`, and runs `verify:forms` and `verify:ask` against it
(the two harnesses that need no running app), with the localhost guard
and `supabase status -o env` reading added to those scripts. That alone
closes the board item. The built-app start and the Playwright suite are
each a separate PR after that, in that order, because the Playwright
suite needs the app-start script to exist.
