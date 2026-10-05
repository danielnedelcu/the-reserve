# Turborepo migration — design

Status: DESIGN, not built. Written 2026-10-05.
Reference: docs/turborepo-reference.md (Lokl's proven patterns).

## Why now

The Reserve currently has one Nuxt app at the repo root. Two things make
wrapping it in Turborepo the right move now rather than later:

1. A second app (the public client portal) is coming. It is far easier to
   wrap one app into Turborepo and then add a second app into the ready
   structure than to retrofit Turborepo around two apps that grew
   separately.
2. Turborepo's monorepo shape — specifically `supabase/` at the root,
   directly available to CI — enables the local Supabase stack in CI that
   closes the board's "dedicated CI Supabase project for the verify:\*
   harnesses" punch-list item. No second hosted project needed.

## What this migration is NOT

- It is NOT a shared-package extraction. `packages/ui` and `packages/types`
  are Lokl patterns for a two-app monorepo. The Reserve has one app today,
  and The Reserve's `shared/` directory is already the single-app
  equivalent. No packages are extracted until the second app exists and
  reveals what's actually shared. Premature extraction produces wrong
  abstractions.
- It is NOT a workspace-manager change. The Reserve uses npm workspaces,
  matching Lokl. No switch to pnpm.
- It is NOT a `create-turbo` bootstrap. That starter produces unused
  `@repo/eslint-config` and `@repo/typescript-config` packages (confirmed
  in Lokl). Start from a clean skeleton; add only what's needed.

## Target structure

```
TheReserve/                    ← repo root (workspace root)
├── apps/
│   └── reserve/               ← the current app, moved here
│       ├── app/               ← Nuxt 4 app/ dir (unchanged)
│       ├── server/            ← server routes (unchanged)
│       ├── components/        ← (unchanged)
│       ├── shared/            ← (unchanged — the single-app equivalent
│       │                         of packages/types + packages/ui;
│       │                         stays here until a second app exists)
│       ├── package.json       ← app-level deps (nuxt, ui-thing, etc.)
│       ├── nuxt.config.ts
│       ├── tsconfig.json
│       └── .env               ← app-level env (gitignored)
├── supabase/                  ← REPO-LEVEL (was inside the app)
│   ├── migrations/
│   ├── config.toml
│   └── .temp/                 ← gitignored
├── docs/                      ← REPO-LEVEL (was inside the app)
│   ├── design/
│   ├── schema/
│   ├── TODO.md
│   └── deployment.md
├── .claude/                   ← REPO-LEVEL (skills, CLAUDE.md)
├── scripts/                   ← REPO-LEVEL (verify harnesses, db scripts)
├── .github/                   ← REPO-LEVEL (CI workflow)
├── package.json               ← workspace root (workspaces, db:* scripts,
│                                 turbo task aliases)
├── turbo.json                 ← pipeline definition
├── .nvmrc                     ← Node pin (22.22.2, unchanged)
└── .env.example               ← REPO-LEVEL (documents all env vars)
```

## What moves where

### Stays at the repo root (repo-level concerns)

- `supabase/` — the DB is shared across all apps; it was always
  repo-level conceptually. This is the key move that enables CI.
- `docs/` — project-wide documentation
- `.claude/` — skills apply to the whole repo
- `scripts/` — the verify:\* harnesses and any db tooling scripts
- `.github/workflows/` — CI
- `.nvmrc` — Node version for all apps
- `.env.example` — documents every env var across all apps

### Moves into `apps/reserve/`

- Everything that is currently the Nuxt app: `app/`, `server/`,
  `components/`, `shared/`, `public/`, `nuxt.config.ts`, `tsconfig.json`,
  `package.json` (the app-level one), `tailwind.config.ts`, etc.
- The app's `.env` (gitignored, app-level secrets)

### New at the repo root

- `package.json` (workspace root — workspaces config, db:\* scripts,
  turbo task aliases, devDependencies: turbo, typescript)
- `turbo.json` (pipeline)

## The `turbo.json` pipeline

Copied from Lokl's proven four-task shape, with one addition (test):

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env*"],
      "outputs": [".output/**"]
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "check-types": {
      "dependsOn": ["^check-types"]
    },
    "test": {
      "dependsOn": ["^test"],
      "inputs": ["$TURBO_DEFAULT$"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

The `test` task is the addition Lokl lacks — The Reserve has a 256-test
suite and CI gates on it. Turbo caches test runs by input hash, so a
`turbo test` that sees no changed files skips the run. When the second
app's tests land, `turbo test` runs both apps in parallel automatically.

No remote cache for now (matches Lokl). Add it when the second engineer
joins and parallel CI runs become valuable.

## The workspace root `package.json`

```json
{
  "name": "the-reserve",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo check-types",
    "test": "turbo test",
    "db:push": "cd supabase && npx supabase db push",
    "db:types": "npx supabase gen types typescript --local > apps/reserve/shared/types/database.ts",
    "db:docs": "tbls doc",
    "verify:forms": "node scripts/verify-forms.mjs",
    "verify:leads": "node scripts/verify-leads.mjs",
    "verify:ask": "node scripts/verify-ask.mjs",
    "verify:messages": "node scripts/verify-messages.mjs"
  },
  "devDependencies": {
    "turbo": "latest"
  }
}
```

Key decisions in this shape:

- `db:*` scripts run from the repo root, pointing at `supabase/` (now
  at the repo root) and outputting types to the app's path
- The verify:\* harnesses stay as root scripts outside Turbo (they need
  live DB access and are not cacheable — same as Lokl's pattern)
- `typecheck` aliases to `turbo check-types` (matching the existing CI
  workflow's `npm run typecheck` command — the CI workflow needs no change)
- `test` aliases to `turbo test` (same)

## The app `package.json` (apps/reserve/package.json)

Gets a `name` field (`"@reserve/app"` or `"@repo/reserve"` — decide below)
and keeps all its current dependencies. The workspace root's `devDependencies`
holds only `turbo`; everything Nuxt-specific stays in the app.

## The typegen target path

Currently: the `db:types` script outputs to a path relative to where it
runs. After the move, `supabase/` is at the repo root and `database.ts`
lives at `apps/reserve/shared/types/database.ts`. The script at the root
targets that path absolutely. Lokl uses absolute paths in both apps for
exactly this reason (`supabase.types` in `nuxt.config.ts` also points
at the generated file by path — check the current `nuxt.config.ts` for
the `supabase.types` setting and update it to the new path).

## The CI local Supabase stack (the board item this closes)

Lokl's CI applies migrations from scratch against a local Supabase stack
in the runner and runs tests against it. The Reserve's CI currently runs
tests without any DB (tests pass because the suite mocks Supabase). But
the verify:\* harnesses need a live DB and are currently excluded from CI.

After the migration, with `supabase/` at the repo root and directly
available to CI, the GitHub Actions workflow can:

1. Run `npx supabase start` in the runner
2. Apply all migrations (`npx supabase db push --local`)
3. Run `npx supabase gen types typescript --local > apps/reserve/shared/types/database.ts`
4. Run the verify:\* harnesses against the local stack

This closes the board's "dedicated CI Supabase project for the verify:\*
harnesses" item — no second hosted project needed, the local stack IS the
CI project. This is a separate CI workflow update (after the migration),
not part of the migration itself.

## Fixed port for the reserve app

Lokl's apps run on fixed ports (3100, 3101). The Reserve should have a
fixed port in its `nuxt.config.ts` devServer setting (e.g. 3000, matching
current behavior, or a new fixed port). This prevents the "dev server
came back on a new port" problem that caused repeated pane re-logins
during development. The port guard is one line in `nuxt.config.ts`.

## Decisions still to make (resolve before building)

1. **App workspace name** — `@reserve/app` (product-scoped) or `@repo/reserve`
   (Lokl's convention). My lean: `@repo/reserve` for consistency with Lokl,
   so when the second app is `@repo/portal`, the naming is coherent.

2. **Fixed dev port** — 3000 (current default) or something else. 3000 is
   fine; just make it explicit in `nuxt.config.ts` so it never changes.

3. **Node version** — Lokl uses Node 24; The Reserve's `.nvmrc` pins 22.22.2.
   The CI workflow uses `.nvmrc`. No change needed for the migration; just
   note the difference if Lokl and The Reserve ever share a CI runner.

4. **The `packages/` directory** — create it empty now (so `workspaces:
["apps/*", "packages/*"]` is valid) or add it only when the first
   package is extracted. Lean: create it with a `.gitkeep` so the workspace
   config works and the intent is clear.

## Build order (how the migration executes)

This is mechanical — no code changes, only relocation and config. Execute
in reviewable pieces, each verified before the next:

1. **Create the skeleton** — repo-root `package.json` (workspace config),
   `turbo.json`, empty `packages/` directory. No app moves yet. Verify:
   `npm install` works, `turbo` is available.

2. **Move `supabase/` to the repo root** — the most important structural
   move. Update `db:*` scripts to run from the root. Verify: `npm run
db:push` works from the repo root (dry-run or against a local stack).

3. **Move the app into `apps/reserve/`** — move all current app files.
   Update the app's `package.json` with a `name` field. Update any paths
   in `nuxt.config.ts` that referenced the old root location (especially
   `supabase.types`). Verify: `npm run dev` starts the app on the fixed
   port, `npm run typecheck` passes, `npm test` passes.

4. **Move repo-level docs, scripts, .claude** — `docs/`, `scripts/`,
   `.claude/` stay at the repo root (they're already logically there;
   this step just confirms nothing broke when the app moved).

5. **Update the CI workflow** — `npm run typecheck` and `npm test` now
   run via `turbo check-types` and `turbo test` respectively, but the
   aliases in the root `package.json` mean the CI commands are unchanged.
   Verify: push a branch, both CI checks pass.

6. **Add the fixed port** — one line in `apps/reserve/nuxt.config.ts`.
   Verify: dev server always starts on that port.

## Verification bar (per step)

After every step, not just at the end:

- `npm run dev` — the app starts, a page loads
- `npm run typecheck` — 0 errors
- `npm test` — 256 tests green, exit 0
- `npm run db:push` — the migration chain works from the new location
- `npm run lint` — exit 0

The verify:\* harnesses are not run during the migration (they need a live
hosted DB). They're verified post-migration when the CI local-stack work
lands.

## What this migration does NOT change

- The app's code, components, routes, server routes — untouched
- The Supabase project (hosted) — untouched
- The GitHub branch protection rules — untouched
- The pre-launch checklist — unchanged, though `db:push` path updates
  should be reflected in `docs/deployment.md`
- CLAUDE.md conventions — unchanged (they apply repo-wide already)

## Relationship to other docs

- `docs/turborepo-reference.md` — the Lokl patterns this design is based on
- `docs/deployment.md` — update after migration: the `db:*` script paths,
  the Vercel monorepo configuration (set the Vercel root to `apps/reserve/`
  and the build command to `turbo build --filter=@repo/reserve`)
- `docs/TODO.md` — the "dedicated CI Supabase project" punch-list item
  closes when the CI local-stack workflow lands (a separate task after
  this migration)
