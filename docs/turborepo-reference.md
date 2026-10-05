# Turborepo reference — how Lokl is laid out

Read 2026-10-05 from `~/turbo` (the Lokl marketplace, HEAD `009afe9`),
as the foundation for The Reserve's own Turborepo migration design.
Read-only: nothing in either repo was changed to produce this. Lokl and
The Reserve share no accounts, keys or code; this document copies
SHAPES, never values.

Lokl is two Nuxt 4 apps and one Supabase project in an npm-workspaces
monorepo driven by Turborepo. The parts worth carrying are the repo
skeleton, the task pipeline, the way the generated database types reach
every app, the per-app port and build discipline, and the CI shape. The
parts NOT to copy are the ones that exist only because Lokl has two apps
and two surfaces; The Reserve has one app today.

## 1. Workspace manager and its config shape

**npm workspaces**, not pnpm or yarn. The root `package.json` declares
them; there is no `pnpm-workspace.yaml`, the `.npmrc` is empty, and the
lockfile is `package-lock.json` (one, at the root, covering every
workspace).

```json
{
  "name": "turbo",
  "private": true,
  "packageManager": "npm@11.17.0",
  "engines": { "node": ">=24" },
  "workspaces": ["apps/*", "packages/*"]
}
```

- `.nvmrc` pins Node 24; CI reads it with `node-version-file`.
- Internal packages are referenced as `"@repo/types": "*"` and
  `"@repo/ui": "*"` in the apps' `dependencies`. npm links them as
  symlinks in the root `node_modules/@repo/` (`ui -> ../../packages/ui`
  and so on). No `workspace:` protocol: that is pnpm/yarn syntax.
- Hoisting is npm's default. Almost everything lands in the root
  `node_modules`; each app's own `node_modules` holds only a handful of
  version-conflicting packages (seven entries in each app, one in the
  UI layer, none in the types package).
- Root `devDependencies` are the tools that run from the root:
  `turbo`, `supabase`, `typescript`, `vue-tsc`, `prettier`,
  `dotenv-cli`, `@playwright/test`, `jsdom`. App-level dependencies
  (Nuxt, Vue, Stripe, Zod…) live in each app's `package.json`.
- Running one workspace's script: `npm run dev -w website` (npm's
  `-w` flag), which is what `.claude/launch.json` uses.

## 2. The `turbo.json` pipeline

The whole file:

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env*"],
      "outputs": [".output/**", ".nuxt/**"]
    },
    "lint":        { "dependsOn": ["^lint"] },
    "check-types": { "dependsOn": ["^check-types"] },
    "dev":         { "cache": false, "persistent": true }
  }
}
```

Four tasks, each mapped onto a script of the same name in every
workspace that has one:

| Task | What runs per workspace | Dependencies | Cached |
| --- | --- | --- | --- |
| `build` | `nuxt build` in each app | `^build`: dependencies' builds first | yes: outputs `.output/**`, `.nuxt/**`; inputs are the default file set PLUS `.env*`, so an env change invalidates the cache |
| `lint` | `eslint .` (admin only; website has no lint script) | `^lint` | yes (default, no outputs declared) |
| `check-types` | `nuxt typecheck` in each app, `tsc --noEmit` in `@repo/types` | `^check-types`: the types package is checked before the apps that import it | yes (default) |
| `dev` | each app's `dev` script | none | no; `persistent` keeps both dev servers alive side by side |

Root scripts wrap them: `build`, `dev`, `lint`, `check-types` are
`turbo run <task>`, and `typecheck` is `turbo run check-types
--continue` (keep going after one app fails so both reports arrive).

What is NOT in the pipeline matters as much:

- **No `test` task.** Unit tests, database tests, app tests and e2e
  tests are plain root scripts (`test:ui`, `db:test`, `db:test:app`,
  `test:e2e`) that call `tsx` or the Supabase CLI directly. Turbo
  orchestrates the per-app build/lint/typecheck; everything touching
  the database or a running app is outside it.
- **No remote cache.** `.turbo/` at the root holds the local cache and
  preferences only; nothing is configured for Vercel Remote Cache.
- `"ui": "tui"` is Turborepo's interactive terminal view for `dev`.

Caching nuance worth knowing: `.env*` as a build input means the local
`.env` contents feed the cache key. Harmless locally; in CI there is no
`.env`, so builds hash only the source.

## 3. The `apps/` structure

Two apps, named by what they are, not by framework:

| App | Package name | Port | What |
| --- | --- | --- | --- |
| `apps/website` | `website` | 3100 | Public site, sign-in, provider dashboard at `/dashboard`, every Stripe call and webhook |
| `apps/admin` | `admin` | 3101 | Owner-only tool, `ssr: false`, `noindex`; reaches Stripe only through the website's `/api/admin/*` routes |

Each app is a complete Nuxt 4 project: its own `nuxt.config.ts`,
`app/` (pages, components, composables, layouts, middleware, utils),
`server/`, `public/`, `tests/`, `.env` + `.env.example`, `.gitignore`,
`eslint.config.mjs` (the Nuxt-generated `withNuxt(...)`), a `CLAUDE.md`
of app-specific conventions, and a `tsconfig.json` that is only
`references` into `.nuxt/tsconfig.*.json`.

Per-app scripts follow one shape:

```json
{
  "build": "nuxt build",
  "dev": "node ../../scripts/check-port.mjs 3101 \"the lokl admin app\" && nuxt dev",
  "preview": "nuxt preview",
  "postinstall": "nuxt prepare",
  "lint": "eslint .",
  "check-types": "nuxt typecheck"
}
```

Two app-level patterns are deliberate and documented in Lokl's
`CLAUDE.md`:

- **Fixed ports, guarded.** `devServer.port` is set in each
  `nuxt.config.ts`, and the `dev` script runs `scripts/check-port.mjs`
  first, which refuses to start if the port is taken. Nuxt would
  otherwise fall back to another port silently, and the Supabase
  redirect URLs and Stripe return URLs are registered for the fixed
  ones. Lokl keeps clear of 3000–3001 because The Reserve uses them.
- **Build checks in separate folders.** `npm run build:check` sets
  `LOKL_BUILD_CHECK=1`, and each `nuxt.config.ts` then builds into
  `.nuxt-check` / `.output-check` with its own Vite cache, so a build
  never clobbers the `.nuxt` a running dev server reads (a plain
  `nuxt build` beside a dev server broke every page with a 500 once).
  Both folders are gitignored.

Both apps `extends: ["@repo/ui"]` and point `supabase.types` at the
generated types by ABSOLUTE path
(`fileURLToPath(new URL("../../packages/types/src/database.ts",
import.meta.url))`), because the Supabase module resolves relative
paths from its own folder.

## 4. The `packages/` shared packages

Four packages. Two are load-bearing; two are leftovers from the
`create-turbo` starter that nothing depends on.

### `@repo/ui` (`packages/ui`) — the shared Nuxt layer

A Nuxt layer, not a library: `"main": "./nuxt.config.ts"` is what makes
`extends: ["@repo/ui"]` resolve. It carries:

- the ui-thing component set (150 components under
  `app/components/Ui/`), installed and maintained by the ui-thing CLI
  from inside the layer (`ui-thing.config.ts` lives here, `force:
  false` so an `add` cannot overwrite a customised component silently);
- 19 shared Lokl components (`DatePicker`, `MoneyInput`, `SignInForm`,
  `NotificationBell`, `StatusBadge`…), shared composables and utils
  (`formatMoney`, `zonedTime`, `zodSchema`, `signInRedirect`…);
- the theme: `app/assets/css/tailwind.css` with the Tailwind 4 `@theme`
  tokens, loaded by absolute path from the layer's `nuxt.config.ts`;
- the Nuxt modules every app needs (`@nuxtjs/color-mode`, `@nuxt/icon`,
  `@nuxt/fonts`, `@nuxt/image`, `@vueuse/nuxt`, `@vee-validate/nuxt`,
  `motion-v/nuxt`, `vue-sonner/nuxt`) and their configuration, declared
  ONCE here rather than in each app;
- its own `tests/` (six `tsx`-run unit tests, invoked from the root
  `test:ui` script).

Depended on by: `website`, `admin`. Dependencies: everything UI
(reka-ui, tailwindcss, tailwind-variants, @tanstack/vue-table,
vee-validate, zod…), so the apps do not declare them.

Three layer-specific rules Lokl learned the hard way, all recorded in
its `docs/frontend.md` and the layer's own config comments:

1. Inside a layer `~` resolves to the EXTENDING app, not the layer, so
   the layer's config uses `fileURLToPath(new URL("./",
   import.meta.url))` for its own paths, and any `~/` import the CLI
   writes into a new component is replaced with a relative path.
2. Tailwind only scans the app being built, so the layer's CSS carries
   `@source "../../";` to scan the layer's own components too, or
   classes used only inside them are never generated.
3. The ui-thing CLI reinstalls `yup` whenever it adds a vee-validate
   component; Lokl removes it after each add and uses a local
   `zodSchema()` adapter because the official `@vee-validate/zod` only
   supports Zod 3.

### `@repo/types` (`packages/types`) — shared types and schemas

A plain TypeScript package (`exports: { ".": "./src/index.ts" }`, no
build step, `check-types` is `tsc --noEmit`). `src/database.ts` is the
Supabase-generated types; the other files are hand-written domain
types and Zod form schemas (`bookings.ts`, `forms.ts`, `listings.ts`,
`roles.ts`…), re-exported from `index.ts`.

Depended on by: `website`, `admin`, and transitively the UI layer's
components. Dependencies: `zod` only.

### `@repo/eslint-config` and `@repo/typescript-config` — unused starter leftovers

Both are the `create-turbo` starter's React/Next presets
(`@next/eslint-plugin-next`, `eslint-plugin-react-hooks`, a `NodeNext`
`base.json`). Neither app depends on them: the apps use Nuxt's own
generated ESLint config and `.nuxt/tsconfig.*.json`. The root
`README.md` is likewise the untouched starter README describing
`docs` and `web` Next.js apps that do not exist. They are inert, not
harmful; a migration starting fresh should simply not create them.

## 5. Where the database layer lives

**Repo-level, at `supabase/`**, beside `apps/` and `packages/`, never
inside an app. One Supabase project serves both apps, so the schema
belongs to neither.

```
supabase/
  config.toml        local stack: API 55321, DB 55322, Studio 55323…; auth
                     site_url + redirect URLs list BOTH apps' ports (and the
                     e2e ports 3200/3201); schemas exposed: public,
                     graphql_public, private (service role only)
  migrations/        33 files, one per change, timestamped
  tests/             pgTAP access-rule tests (*.test.sql, one per table or
                     rule) + app-level tests in tests/app/*.test.mts run
                     with tsx against a running app
  templates/         sign-in email template
  .gitignore         .branches, .temp
```

The scripts that touch it are ROOT scripts, because the CLI's
`config.toml` and `migrations/` are at the root:

| Script | What |
| --- | --- |
| `db:test` | `supabase db start && supabase db reset --local && supabase test db`: rebuild the LOCAL stack from migrations, run pgTAP (needs Docker) |
| `db:push` | `npm run db:test && supabase db push && npm run db:types && npm run db:docs`: tests gate the push |
| `db:types` | `supabase gen types typescript --linked --schema public,private > packages/types/src/database.ts` (written via a `.tmp` then `mv`, so a failed generation never leaves an empty file) |
| `db:docs` | `dotenv -e .env -- tbls doc --force -c .tbls.yml` into `docs/schema/` |

Two things follow from the placement:

- The generated `database.ts` lands in `packages/types`, which is how
  one schema types every app. The root `.env` exists ONLY for `db:*`
  (`TBLS_DSN`); each app has its own `.env` for runtime.
- CI runs a real local Supabase stack in the runner
  (`supabase/setup-cli` + `supabase start`), runs pgTAP, builds both
  apps with `build:check`, starts them against that stack from a script
  that reads the local keys from `supabase status` and refuses anything
  but a local URL, then runs the app tests. No hosted project and no
  secret is involved in the default jobs; Stripe and e2e jobs run only
  when a `stripe-sandbox` environment secret exists, and refuse any key
  that is not test-mode.

## 6. Patterns worth carrying into The Reserve's migration

In rough order of value for a single-app repo:

1. **The skeleton exactly: `apps/*`, `packages/*`, `supabase/` at the
   root, npm workspaces, one root lockfile.** The Reserve is already on
   npm with the same Nuxt 4 + Supabase + ui-thing stack, so the move is
   a relocation, not a rewrite: today's root `app/`, `server/`,
   `shared/`, `nuxt.config.ts`, `tests/`, `vitest.config.ts` become
   `apps/<app>/…`; `supabase/`, `docs/`, `scripts/` stay at the root
   where they already are. `.claude/launch.json` changes to `npm run
   dev -w <app>`.
2. **The four-task `turbo.json`** as written: `build` with `^build` and
   `.output`/`.nuxt` outputs, `lint`, `check-types` with `^check-types`,
   and an uncached persistent `dev`. Root scripts become thin `turbo
   run` wrappers; `typecheck` keeps `--continue`.
3. **Tests outside Turbo, as root scripts.** The Reserve's `vitest run`
   and the `verify:*` harnesses stay root scripts calling into the app
   workspace; Lokl shows this is fine and keeps the pipeline honest about
   what is cacheable.
4. **`db:*` stays at the root and `db:push` chains typegen and docs**,
   which The Reserve already does. The one change is WHERE
   `database.ts` lands: today `shared/types/database.ts` inside the app;
   in the monorepo it moves to wherever shared types live (see 7 for
   whether that is a package yet). Copy the `.tmp` + `mv` write so a
   failed generation cannot truncate the file.
5. **The fixed-port guard** (`scripts/check-port.mjs`). The Reserve has
   `"autoPort": true` in `launch.json` and a known 3000→3001 fallback;
   the reason Lokl forbids the fallback (registered redirect and return
   URLs) applies to The Reserve's Supabase auth and Stripe return URLs
   just as much once there is a second app or a staging address.
6. **Build checks in separate folders** (`LOKL_BUILD_CHECK`-style
   `buildDir` / `nitro.output.dir` / `vite.cacheDir` switch). Cheap, and
   it removes a real footgun once CI or a script builds while a dev
   server is running.
7. **The CI shape**: a `checks` job (typecheck + unit tests, no
   services) separate from a `database` job (local Supabase in the
   runner, migrations applied from scratch, harnesses against it). The
   Reserve's current CI is the `checks` half; the `database` half is the
   missing piece that would let the `verify:*.mjs` harnesses run in CI
   instead of only locally against the hosted project. This answers the
   board's "dedicated CI Supabase project" item differently and better:
   no second hosted project, a throwaway local stack per run.
8. **Per-workspace `.env.example` plus a root `.env` only for `db:*`.**
   The Reserve's deployment matrix already separates runtime from tooling
   variables (`TBLS_DSN` "NOT deployed"); the monorepo makes that split
   physical.
9. **A `supabase.types` absolute path** in the app's `nuxt.config.ts`
   the moment `database.ts` leaves the app folder; the module resolves
   relative paths from its own location.

## 7. Lokl-only decisions not to copy blindly

- **`packages/ui` as a Nuxt layer.** It exists because TWO apps need one
  component set and one theme. The Reserve has one app, so extracting
  its `app/components/Ui/`, theme and modules into a layer now is pure
  cost: a second place for `~` to mean the wrong thing, a `@source`
  rule to remember, the CLI's `yup` quirk, and a `postinstall: nuxt
  prepare` in a package that renders nothing. Keep ui-thing inside
  `apps/<app>` until a second Nuxt app actually extends it. The
  deployment doc's own instruction agrees: "skeleton only, no premature
  shared-package extraction".
- **`packages/types` as a package.** Same reasoning, with one nuance:
  The Reserve already has a `shared/` folder (Nuxt's built-in
  shared-code directory, auto-imported by both app and server) holding
  `types/database.ts`, `messaging/unread.ts`, `communications/kinds.ts`,
  `campaigns/analytics.ts` and the form contracts. That is the
  single-app equivalent of `@repo/types`, with no package boundary to
  maintain. Moving it to `packages/types` only earns its keep when a
  second workspace imports it. The one thing to decide at migration
  time is the typegen target path, which is a one-line script change
  either way.
- **`@repo/eslint-config` and `@repo/typescript-config`.** Starter
  leftovers, unused even in Lokl. Do not create them.
- **Two apps with a cross-app contract.** The admin app reaching Stripe
  only through the website's `/api/admin/*` with an origin allowlist,
  `NUXT_ADMIN_ORIGIN` / `NUXT_PUBLIC_WEBSITE_URL`, and `ssr: false` on
  the admin are consequences of Lokl's split. The Reserve's one app
  holds the Stripe key and the admin surface together; nothing to
  mirror until a public marketing or portal app exists. When it does,
  the shape to copy is "one app owns the secret, the other calls it".
- **Fixed ports 3100/3101.** Lokl chose them specifically to stay out of
  The Reserve's 3000–3001. The Reserve keeps 3000 and, if it adopts the
  port guard, reserves 3001 for its own second app rather than
  inheriting Lokl's numbers.
- **The `private` schema exposed to the API, service-role only.** A
  Lokl money-isolation choice (`private.booking_records`); The Reserve
  isolates money with RLS and append-only policies in `public`, and
  nothing here argues for changing that.
- **`db:test` as a gate inside `db:push`.** Lokl has pgTAP suites that
  rebuild the local database from migrations; The Reserve's harnesses
  run against the hosted project under the service role and are not a
  from-scratch rebuild. Chaining them into `db:push` would gate a push
  on the state of the database it is about to change. Adopt the gate
  only once The Reserve has a local-stack rebuild test to put there
  (pattern 7 above is the prerequisite).
- **Email mode switches, the admin-origin allowlist, the Anthropic
  guide drafts, Sanity, Lenis, Swiper, the `.email-previews` folder.**
  Product features of a marketplace; none of them are monorepo
  decisions.

## What the migration design has to decide

Left open on purpose, for `docs/design/turborepo-migration.md`:

- The app's workspace name (`apps/app`? `apps/reserve`? `apps/staff`?).
  Lokl names apps by audience (`website`, `admin`); The Reserve's single
  app is the staff tool, and a later public app would be the second.
- Whether `shared/` stays Nuxt's `shared/` inside the app (zero-cost)
  or becomes `packages/types` on day one (pays off only with a second
  consumer). The recommendation from the Lokl evidence is the former.
- The typegen target path and the `supabase.types` absolute path, which
  move together.
- Whether to adopt the port guard and the build-check folders in the
  same PR or after.
- The CI `database` job, which is the one genuinely new capability the
  monorepo shape unlocks for The Reserve and can be a follow-up PR.
