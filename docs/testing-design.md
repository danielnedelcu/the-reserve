# Testing infrastructure — design

Status: DESIGN, not built. Written 2026-10-05.
Reference: docs/testing-reference.md (Lokl's proven patterns).

## What this covers

Two additions to The Reserve's CI, designed together because they share
the local Supabase stack:

1. **The `database` CI job** — starts the local stack, resets from
   migrations, and runs the verify:\* harnesses against it. Closes the
   board's "dedicated CI Supabase project" item. No secrets needed.
2. **The Playwright e2e suite** — numbered journey tests that run against
   the local stack with a built app. Requires a running server; follows
   the database job.

Built in two separate PRs:

- PR A: the `database` job (closes the board item immediately)
- PR B: the Playwright suite (larger, depends on PR A)

## The two findings from Lokl that shape this design

### 1. The auth cookie prefix (the non-obvious silent failure)

Nuxt's Supabase module fixes the auth cookie name at BUILD time from the
Supabase project URL the build environment pointed at. When a laptop build
runs against the local stack, the cookie name is keyed to the hosted
project's URL — so every page reads as signed out against the local stack,
even with valid credentials, because the browser has a cookie named for
the hosted project and the app is looking for one named for the local one.

The fix (one line in the app-start script): set the auth cookie prefix
from the local stack's URL before starting the app. Lokl does this; The
Reserve must do the same. Without it, every Playwright test that visits
an authenticated page will see the unauthenticated state, silently. This
is the first thing to get right and the last thing anyone would guess.

The line in the start script (scripts/ci-start-app.mjs, as built):

```js
NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
```

The same derivation `@supabase/ssr` uses, so the cookie the test writes and
the cookie the app looks for have one name.

### 2. The ledger and the money journey cleanup problem

Lokl deletes bookings in test cleanup under a replica session role
because its schema forbids deleting them in real use. The Reserve's
ledger is append-only by explicit REVOKE — the same cleanup approach would
exercise exactly the forbidden path, which is both wrong (it would succeed
under a service-role cleanup script, undermining the integrity guarantee)
and misleading (a test that cleans up by breaking the rule it's testing).

**Decision required before the first money journey:**

Option A — **Tagged rows, left in place** (the C2 baseline pattern):
Test transactions are tagged with a test run ID and never deleted. The
test verifies the row exists and has the right values; cleanup is a
periodic manual or cron-driven sweep by tag. This is what the C2 ledger
baseline already does and it's honest — the ledger is append-only in
tests as in production.

Option B — **A dedicated test organisation**: Every test run creates a
fresh org, runs all its money journeys inside it, and the entire org is
deleted at the end (cascading through every table including the ledger).
The ledger rows go with the org. This is the cleanest isolation but
requires an org-creation fixture and trusts the cascade rather than the
explicit cleanup.

**My recommendation: Option B (test org) for the Playwright suite,
Option A (tagged rows) for the verify:\* harnesses.** The harnesses
already use tagged rows (PREVIEW-6MO, PHASE4-TEST, etc.) and that
pattern is proven. The Playwright suite runs full journeys that cross
many tables; a test org with cascade deletion is cleaner than tagging
dozens of rows across a dozen tables. The org delete is one statement.
Confirm before building.

## PR A — the `database` CI job

### What it does

```yaml
database:
  name: database (local stack + harnesses)
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
        cache: npm
    - name: Install Supabase CLI
      run: npm install -g supabase@latest
    - name: Start local stack
      run: supabase start --ignore-health-check \
        -x realtime -x storage-api -x imgproxy \
        -x inbucket -x postgrest -x gotrue
      working-directory: .
    - name: Reset database from migrations
      run: supabase db reset --local
    - name: Install dependencies
      run: npm ci
    - name: Run verify harnesses
      run: npm run verify:forms && npm run verify:leads && npm run verify:ask
      env:
        SUPABASE_LOCAL: true
```

The excluded services (`-x` flags) match Lokl's list: everything The
Reserve doesn't use (storage, realtime for CI, imgproxy, inbucket). Keep
realtime excluded unless the harnesses specifically test realtime behavior
(they don't — they test DB state directly).

### The localhost guard

Every verify:\* harness must refuse to run if its database URL resolves
to anything other than localhost. The guard:

```javascript
const url = new URL(process.env.SUPABASE_URL || "");
if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
  console.error("SAFETY: refusing to run against a non-local database.");
  process.exit(1);
}
```

This is the one thing Lokl does that The Reserve's harnesses currently
lack. It must be added to all four verify:\* scripts before the CI job
runs them, so a misconfigured runner can never touch the hosted project.
Same principle as the fail-closed config: refuse rather than degrade.

### The `supabase status` env assembly

The harnesses currently read `.env` from the repo root. In CI, the
local stack's credentials come from `supabase status -o env`. The
harnesses need to pick up the local stack's service role key and URL
rather than the hosted project's. Two ways:

Option A — The CI step exports `supabase status -o env` into the
runner's environment before the harness step. The harnesses read
`process.env.SUPABASE_URL` and `process.env.SUPABASE_SERVICE_ROLE_KEY`
directly (they already do, since that's how `.env` values reach them).
The local values override the `.env` values because environment variables
take precedence.

Option B — The harnesses detect `SUPABASE_LOCAL=true` and call
`supabase status -o env` themselves.

**Recommendation: Option A.** The CI step sets the env; the harnesses
stay unchanged. Separation of concerns: the workflow knows how to talk
to the local stack; the harnesses just need the right values.

### The `turbo.json` pipeline

The database job runs outside Turbo (it needs the local stack, which is
not a Turbo concern). The CI workflow adds a parallel job alongside the
existing `check` job. The existing `check` job is unchanged:

```yaml
jobs:
  check: # existing — typecheck + tests + lint
    ...
  database: # new — local stack + harnesses
    ...
```

Both jobs run in parallel. The database job does not depend on `check`.
A failing harness does not block a typecheck-passing PR (and vice versa).

## PR B — the Playwright e2e suite

AS BUILT 2026-10-06 (stages 1 and 2). Three things in the first draft of
this section followed the design rather than the reference and were
corrected while building: the suite runs against the BUILT app, not the
dev server; sign-in goes through `@supabase/ssr` with an in-memory cookie
jar, never a hand-built cookie; and the browser runs in a zone that is
NOT the spa's. Each is explained where it lands below.

### Stage 1 — build and start the app for tests

- `RESERVE_BUILD_CHECK=1` in `apps/reserve/nuxt.config.ts` builds into
  `.nuxt-check` and `.output-check` with a separate Vite cache, so a test
  build never clobbers a running dev server's `.nuxt`. Both gitignored.
  `npm run build:check` (scripts/build-check.mjs) runs it. The first
  build:check found a real production-build bug: a `v-model` on a cast
  expression in the public form field, which the dev server tolerated and
  the build rejected. Fixed with typed writable computeds.
- `npm run app:start` (scripts/ci-start-app.mjs) starts the built server
  with `NODE_ENV=production` on **3300** (not 3000, and not Lokl's
  3100/3101/3200/3201), assembles its env from the local stack through
  `scripts/_env.mjs`, refuses any non-local URL, sets
  `NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX` from the local URL (the finding in
  section 1 above), looks up the seeded organisation for lead capture,
  records the pid, polls the port, and writes the values a harness must
  share with the app to `node_modules/.cache/ci-app.env`.
  `npm run app:stop` stops it. `supabase/config.toml` lists the 3300 URLs
  among the auth redirects.
- The `e2e` CI job: stack, reset from migrations, export, build, start,
  `verify:leads` against the running app (it joins CI here), then
  Playwright; traces and screenshots uploaded on failure; the app stopped
  in `always()`. Not a required check yet.

### Stage 2 — structure

```
e2e/
├── playwright.config.ts
├── package.json             — `"type": "module"`: the suite loads as ES modules
├── tsconfig.json            — `tsc -p e2e` runs in the typecheck + tests job
├── support/
│   ├── env.ts               — the local stack, through _env.mjs's guard
│   ├── auth.ts              — signIn(context, email, password) via @supabase/ssr
│   ├── data.ts              — TestData: run id, tracked ids, cleanup in order
│   └── fixtures.ts          — test.extend with `data`, cleanup in finally
└── journeys/
    ├── 01-auth.spec.ts
    ├── 02-clients.spec.ts   — stage 3 (built)
    └── 03-scheduler.spec.ts — stage 3: written, exposes the timezone seam
                               (below); not in the suite until that decision
```

At the repo root, matching Lokl. Nothing test-only lives in the app.

### The `playwright.config.ts`

`testDir: ./journeys`, `fullyParallel: false`, `workers: 1` (one stack,
one app), `retries: 0`, trace `retain-on-failure`, screenshot
`only-on-failure`, Chromium at desktop size only until a staging site
exists over HTTPS, `baseURL` from `E2E_BASE_URL` (3300). No `webServer`
block: the app is started by `app:start` before the run, built, the way
CI runs it.

**The suite is ES modules** (`e2e/package.json`, `"type": "module"`).
`support/env.ts` imports `scripts/_env.mjs`, which reads `import.meta.url`
for the repo root. Loaded as CommonJS, Playwright's transform compiles
that `.mjs` to CommonJS and `import.meta` cannot be expressed there:
"Cannot use 'import.meta' outside a module", every spec file failing to
load, "No tests found". It passed on one laptop Node (22.12) and failed
on CI's (22.22) — found by the first CI run, reproduced locally with the
CI version, fixed by loading the suite natively.

**`timezoneId: "America/Los_Angeles"`, on purpose.** The first draft said
Eastern, the spa's own zone. That would let a page that formats by the
browser clock pass. The browser runs in a zone that is NOT the location's,
and every time a journey asserts is the LOCATION's, so the recorded
scheduler seam (the grid positions by the browser clock) fails here
rather than hides.

### The auth helper

`signIn(context, email, password)` runs the password sign-in in the test
code through `createServerClient` from `@supabase/ssr` — the library the
app reads its cookies with — into an in-memory jar, waits for the library
to write, and adds those cookies to the browser context for `localhost`
with `SameSite=Lax`. No cookie is hand-built: if the library changes its
name or format, both sides change together and a mismatch shows as a
login page, never as a quiet pass. Journey 1 signs in through the real
login form AND through the helper and must land on the same signed-in
dashboard, which is the proof the two agree. Switching user mid-test is
`context.clearCookies()` then `signIn` again.

### The TestData fixture

`TestData.create()` finds the seeded organisation; `staffMember(label,
role)` is the first builder: an auth user with a password
(`auth.admin.createUser`, confirmed), a `staff` row in that organisation,
and a `staff_roles` row for one of the four seeded roles. `client()` and
`trackClient()` serve journey 2; `locationInZone()`, `service()` and
`hours()` serve journey 3 (the seeded location moved into a zone for the
run and put back; a bookable service with no intake and no room; the
same weekly hours every day). Every email and display name carries the
run id. `cleanup()` deletes in dependency order (communications, appointments,
clients, services, role rows, staff, auth users, then the location's
zone), runs every step even when one fails, and THROWS at the end if any
did — a row that cannot be removed fails the run instead of accumulating.
That rule came from a run: a super_admin fixture was refused by the
last-super-admin trigger (a fresh stack has no other), nothing reported
it, and the row then counted as "another super admin" for every later
run. No journey uses super_admin now.

### Journey 1 — auth (built)

A front-desk member signs in through the login page and lands on the
dashboard; a signed-out visit to `/clients` is sent to `/login`; an
admin sees the Financials nav entry and a provider, who lacks
`financials.view_summary`, does not (while still seeing Clients, which
they hold, so the absence is not vacuous). Controls are found by role and
accessible name.

### Journey 2 — clients (built)

The front desk creates a client through the sheet, finds them through
the search box in the list the page re-read after saving, opens the
profile through the row's View link, changes the communication channel
from Email to SMS in the preferences section, and reloads: the change
must be there after a fresh load, which is the only proof it was saved
and not merely drawn. The value before the edit is asserted too, so the
change is a change.

### Journey 3 — scheduler (written; exposes the seam)

The seeded location is put in America/New_York for the run; the browser
is in America/Los_Angeles; a provider has hours 10:00–11:00 local, one
60-minute slot; the front desk opens the dialog, picks client, service
and staff, and asks for times. The journey asserts the LOCATION's time,
`10:00 AM`. The dialog offers `7:00 AM`:

```
- "10:00 AM",
+ "7:00 AM",
```

That is the recorded two-timezone seam, exposed on the first run: the
slot labels and the card labels format in the browser clock
(`app/utils/appointmentTime.ts`), and the grid positions cards and builds
its day range from it (`blockStyle`, `fetchRange` in
`app/pages/schedule.vue`). The journey is not marked `fixme` and the
assertion is not moved to the browser's zone; it is held out of the suite
until the seam decision on the board is made, and it is the test that
proves the fix when it is.

### The money journey decision (confirm before building)

Unchanged: before any journey touches the ledger, settle test-org cleanup
(recommended for Playwright) versus tagged rows (the harnesses' pattern).
No money journey is in this PR.

### The test-timeout contention note

The `check` job runs vitest with no server; the `e2e` job runs the built
app on its own VM. No contention in CI. Locally, the Nuxt-environment
vitest files time out when a dev server is BUILDING beside them; the
built app on 3300 does not build, so `test:e2e` and `npm test` can run
side by side.

## Build order

**PR A — the database job (close the board item):**

1. Add the localhost guard to all four verify:\* harnesses
2. Add the `database` job to `.github/workflows/ci.yml`
3. Test locally: `supabase start`, `supabase db reset --local`,
   `supabase status -o env`, then run the harnesses with those env vars
4. Push, confirm the new CI job goes green alongside the existing `check`

**PR B — the Playwright suite (its own PR after PR A), as built:**

1. Stage 1: build-check mode, `app:start`/`app:stop`, the 3300 redirect
   URLs, the `e2e` CI job with `verify:leads` against the running app.
2. Stage 2: `e2e/` skeleton, `tsc -p e2e` in the check job, journey 1
   (auth) passing locally and in CI — the cookie proof every later
   journey depends on.
3. Stage 3: journey 2 (clients) built and in the suite; journey 3
   (scheduler) written, exposed the timezone seam on its first run, held
   out until that decision — never `fixme`, never assert in the browser's
   zone.
4. Money journeys wait for the cleanup decision and their own PR.

## Decisions to confirm before building

1. **Money journey cleanup**: test org (cascade) or tagged rows?
   Recommendation: test org for Playwright, tagged rows for harnesses.
2. **Which journeys in PR B, first slice?** Recommendation: auth,
   clients, and scheduler — no money, no ledger, proves the auth cookie
   fix and the TestData fixture before the harder journeys.
3. **`verify:messages` harness**: still on the punch list — add it to
   PR A alongside the localhost guard, since the CI stack enables it.

## Relationship to other docs

- `docs/testing-reference.md` — the Lokl patterns this design is based on
- `docs/TODO.md` — the "dedicated CI Supabase project" punch-list item
  closes when PR A merges
- `.github/workflows/ci.yml` — both PRs add jobs here
- `docs/deployment.md` — the Playwright job requires `SUPABASE_SERVICE_ROLE_KEY`
  in the CI environment (not in the hosted Vercel env — only in the GitHub
  Actions environment for the local-stack jobs)
