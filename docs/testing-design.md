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

The line in the start script:

```bash
NUXT_PUBLIC_SUPABASE_URL=$(supabase status -o env | grep SUPABASE_URL | cut -d= -f2)
```

Then start the app with that URL so the cookie name matches the stack.

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

### Structure

```
e2e/
├── support/
│   ├── auth.ts          — sign in, session management, cookie prefix fix
│   ├── test-data.ts     — TestData fixture (run id, create, cleanup)
│   └── db.ts            — psql helper for time-travel and state reads
├── 01-auth.spec.ts
├── 02-clients.spec.ts
├── 03-scheduler.spec.ts
├── 04-messaging.spec.ts
├── 05-forms.spec.ts
├── 06-leads.spec.ts
├── 07-checkout.spec.ts
├── 08-communications.spec.ts
├── 09-campaigns.spec.ts
└── ... (numbered journeys, one feature per file)
```

One `e2e/` directory at the repo root (not inside `apps/reserve/`),
matching Lokl's pattern. The test code imports from the app's types
where needed but nothing test-only lives in the app itself.

### The `playwright.config.ts`

At the repo root:

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // sequential within each spec file
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    timezoneId: "America/New_York", // Eastern time — spa is Atlanta-based
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -w @repo/reserve",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      // The auth cookie prefix fix — set from the local stack URL in CI
      NUXT_PUBLIC_SUPABASE_URL: process.env.NUXT_PUBLIC_SUPABASE_URL || "",
      NUXT_PUBLIC_SUPABASE_KEY: process.env.NUXT_PUBLIC_SUPABASE_KEY || "",
    },
  },
});
```

The `timezoneId` is Eastern (`America/New_York`) rather than Lokl's
Los Angeles, because The Reserve is an Atlanta spa. Time-dependent
assertions (appointment times, birthday logic, day-before reminders)
should be asserted in the timezone the spa operates in.

### The auth helper (the cookie prefix fix)

```typescript
// e2e/support/auth.ts
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

export async function signIn(page: Page, email: string, password: string) {
  const client = createClient(
    process.env.NUXT_PUBLIC_SUPABASE_URL!,
    process.env.NUXT_PUBLIC_SUPABASE_KEY!,
  );
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session)
    throw new Error(`Sign in failed: ${error?.message}`);

  // The cookie name is keyed to the Supabase project URL.
  // Set it directly so the browser cookie matches what the app expects,
  // regardless of which stack (local or hosted) the test runs against.
  const cookieName = `sb-${new URL(process.env.NUXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0]}-auth-token`;
  await page.context().addCookies([
    {
      name: cookieName,
      value: JSON.stringify(data.session),
      domain: "localhost",
      path: "/",
    },
  ]);
}
```

This is the Lokl pattern, adapted. The cookie name derives from the
project URL at runtime, so the same auth helper works against both
the local stack and (in future) a staging deployment.

### The TestData fixture

```typescript
// e2e/support/test-data.ts
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

export class TestData {
  private runId = `E2E-${randomUUID().slice(0, 8)}`;
  private serviceClient = createClient(
    process.env.NUXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  private created: Array<{ table: string; id: string }> = [];

  tag(data: Record<string, unknown>) {
    return { ...data, _test_run: this.runId };
  }

  track(table: string, id: string) {
    this.created.push({ table, id });
    return id;
  }

  async cleanup() {
    // Delete in reverse order (dependents before parents)
    for (const { table, id } of [...this.created].reverse()) {
      await this.serviceClient.from(table).delete().eq("id", id);
    }
  }
}
```

For money journeys, the cleanup uses the test-org pattern (see the
decision above) rather than individual row deletes. The ledger rows
cascade with the org.

### The money journey decision (confirm before building)

Before writing any journey that touches the ledger (checkout, the
cancellation fee, campaigns), the cleanup approach must be settled.
Recommendation is Option B (test org with cascade) for Playwright.
This means every money-touching spec creates a fresh org, runs inside
it, and deletes the org in `afterAll`. The org creation is a fixture;
individual tests get a client and a staff session scoped to that org.

### The Playwright CI job

Runs after the `database` job (needs the local stack running):

```yaml
playwright:
  name: e2e (Playwright)
  runs-on: ubuntu-latest
  needs: database
  timeout-minutes: 30
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci
    - run: npx playwright install chromium
    - name: Start local stack
      run: supabase start --ignore-health-check -x realtime -x storage-api -x imgproxy -x inbucket -x postgrest -x gotrue
    - name: Reset database from migrations
      run: supabase db reset --local
    - name: Export local stack env
      run: supabase status -o env >> $GITHUB_ENV
    - name: Run Playwright tests
      run: npx playwright test
    - uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: playwright-report
        path: playwright-report/
```

The `supabase status -o env >> $GITHUB_ENV` line is the env assembly
from Option A above — it exports the local stack's URL, anon key, and
service role key into the runner's environment, which Playwright and
the webServer pick up automatically.

Note: the Playwright job starts its own stack (`supabase start` again)
rather than sharing the `database` job's stack, because GitHub Actions
jobs run on separate VMs. Each job that needs the stack starts it fresh.

### The test-timeout contention note

Flagged during the Turborepo migration: the Nuxt-environment test files
in vitest hit their 10-second setup timeout when a dev server is building
at the same moment. In the CI pipeline:

- The `check` job runs `npm test` (vitest) with no server — fine
- The `playwright` job starts a server via `webServer` in the config

These are separate jobs on separate VMs, so there is no contention. The
issue only surfaces locally when running both at once. Worth noting in
the dev README.

## Build order

**PR A — the database job (close the board item):**

1. Add the localhost guard to all four verify:\* harnesses
2. Add the `database` job to `.github/workflows/ci.yml`
3. Test locally: `supabase start`, `supabase db reset --local`,
   `supabase status -o env`, then run the harnesses with those env vars
4. Push, confirm the new CI job goes green alongside the existing `check`

**PR B — the Playwright suite (its own PR after PR A):**

1. Confirm the money-journey cleanup decision (test org or tagged rows)
2. Add `playwright.config.ts` at the repo root
3. Install Playwright: `npm install -D @playwright/test` at the root,
   `npx playwright install chromium`
4. Write `e2e/support/` (auth, test-data, db helpers)
5. Write journeys starting with the simplest (auth → clients → scheduler),
   adding money journeys after the cleanup decision is made
6. Add the `playwright` job to the CI workflow
7. Push, confirm green

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
