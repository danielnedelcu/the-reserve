# Deployment (Vercel) — design + checklist

Status: DESIGN + CHECKLIST, not yet deployed. Written 2026-09-20.
Nuxt-on-Vercel is well-trodden; the real content here is the INTEGRATION
decisions (Supabase, Stripe, the ask pg connection) and the env-by-env
checklist, not the framework fit.

## The decisions that will misbehave if unplanned

### 1. ASK_DATABASE_URL must use the Supabase POOLER, not the direct connection

The sleeper issue. Ask The Reserve runs generated SQL over a DEDICATED
pg connection (the ask_readonly LOGIN role) — a raw Postgres connection,
not PostgREST. On Vercel each function invocation is a separate
short-lived serverless instance, and raw pg connections do not pool
across invocations: every cold function opens a new connection, and under
load they pile up and exhaust Postgres's connection limit.

This WORKS IN TESTING (low volume, connections don't accumulate) and
BREAKS IN PROD (connection exhaustion). Classic works-in-dev-fails-at-load.

Fix: in production, ASK_DATABASE_URL points at Supabase's connection
POOLER (port 6543, transaction mode), not the direct connection (5432),
and the pg client is configured for serverless — small or no client-side
pool, short idle timeouts — so the pooler manages connection reuse. The
ask_readonly role + its password stay the same; only the host/port/mode
in the DSN change from direct to pooled.

Verify after deploy: run several ask queries in quick succession against
the deployed app and confirm no connection-limit errors; check Supabase's
connection count doesn't climb unbounded.

### 2. Region co-location with Supabase

Supabase is in aws-1-us-west-2 (per the DSNs). Vercel functions must be
pinned to the SAME region, or every DB query pays a cross-region
round-trip — and nearly every route hits Supabase, so a region mismatch
is a latency tax on the whole app. Set the Vercel function region to
us-west-2 to match Supabase.

### 3. Preview deployments must not touch prod resources

Vercel auto-deploys every PR to a preview URL. Those previews would
otherwise carry the public endpoints (lead capture, form submit) and,
if misconfigured, a live Stripe webhook — a preview must never accept
real leads, write real data, or be a registered Stripe endpoint.

Use Vercel's PER-ENVIRONMENT env vars (production / preview / development):
- Preview gets TEST Stripe keys, a non-prod or empty LEADS_ORGANIZATION_ID,
  and must NOT be a registered Stripe webhook endpoint.
- Only PRODUCTION carries live Stripe keys, the prod webhook secret, the
  real LEADS_* values, and the prod FORM_IP_PEPPER.
- Consider Vercel's preview protection (password) so previews aren't
  publicly reachable at all — but note the Stripe webhook route on PROD
  must NOT be behind any such protection, or Stripe can't reach it.

## The decisions that are already right by design

### pg_cron stays in Supabase — deployment-independent

The retention purges (prospect 30d, telemetry 24h, leads 1 month) run via
pg_cron INSIDE Postgres, not in the app. This is a deployment advantage:
serverless hosts have no persistent process to run cron, so an app-level
scheduler would have been a problem on Vercel. Choosing pg_cron over an
external scheduler (originally for the silent-failure reason) also means
scheduled work needs nothing from Vercel — it keeps running regardless of
deploys. No Vercel Cron, no worker process needed.

### The verify:* harnesses and TBLS_DSN are tooling, not runtime

The harnesses insert/delete against a live DB with the service role —
they are LOCAL pre-merge / CI checks, never part of the deployed app.
TBLS_DSN generates schema docs locally. None of this belongs in the
Vercel runtime env or the deployed bundle. The Vercel build command is
just the Nuxt build; confirm it does not invoke scripts/ or the harnesses.

## Sequencing: Turborepo before Vercel

If the Turborepo restructure is happening (wrap the single app now, before
the second/public app), do it BEFORE configuring Vercel. Vercel has
first-class monorepo/Turborepo support (multiple apps from one repo,
per-app build settings, remote caching). Setting up Vercel once for the
monorepo shape beats setting it up for the single app and reconfiguring
after the restructure. Order: Turborepo wrap (skeleton only, no premature
shared-package extraction) -> Vercel setup for the monorepo.

Also relevant: the marketing site (which hosts the landing pages that POST
to the lead-capture endpoint) is a SEPARATE surface. Decide where it lives
— a second Vercel project in the same monorepo is clean and makes
LEADS_ALLOWED_ORIGINS point at a known Vercel origin. Its origin is what
goes in LEADS_ALLOWED_ORIGINS on the app's production env.

## Environment variables — the completeness matrix

Every one must be set in Vercel, per environment. Many are FAIL-CLOSED:
missing one is a visible feature outage, not a silent bug (by design).
Several are environment-SPECIFIC (a prod value differs from dev).

| Var | Prod value | Notes |
|---|---|---|
| NUXT_PUBLIC_SUPABASE_URL | prod project URL | public |
| NUXT_PUBLIC_SUPABASE_KEY | publishable key | public, safe to expose |
| NUXT_SUPABASE_SECRET_KEY | the ROTATED secret key | server-only; rotated 2026-09-20 |
| ASK_DATABASE_URL | POOLER DSN (6543, tx mode) | NOT the direct connection — see decision 1 |
| RESEND_API_KEY | rotate before launch | was chat-exposed; pre-launch rotation |
| MAIL_FROM | verified sender domain | must be verified in Resend |
| STRIPE_SECRET_KEY | LIVE key | test key in preview only |
| NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | LIVE publishable | test in preview |
| STRIPE_WEBHOOK_SECRET | PROD webhook's secret | per-endpoint; NOT the CLI whsec_ |
| ANTHROPIC_API_KEY | the-reserve project key | server-only |
| FORM_IP_PEPPER | a DIFFERENT prod value | fail-closed; per-env; openssl rand -hex 32 |
| LEADS_ORGANIZATION_ID | the real org id | fail-closed; empty in preview |
| LEADS_ALLOWED_ORIGINS | the marketing site's real origin | never *; fail-closed cross-origin |
| TBLS_DSN | NOT deployed | tooling only |

FORM_IP_PEPPER, in more detail (moved here from the board): it keys the
HMAC over visitor IPs on the public intake form, so it must DIFFER per
environment, and rotating it re-anonymises history — existing
form_submission_attempts rows stop matching new hashes, which resets the
rate-limit counters rather than corrupting anything. Absent, the public
submission route refuses to serve: fail-closed on purpose, so a missing
secret shows up as an outage, not as silently weaker hashing.

## Deploy checklist (pre-launch)

Before first production deploy:
- [ ] Turborepo wrap done (if doing it) and Vercel configured for the
      monorepo shape.
- [ ] Vercel function region set to match Supabase (us-west-2).
- [ ] ASK_DATABASE_URL set to the pooler DSN (6543, tx mode), pg client
      configured for serverless; verified no connection-climb under a
      burst of ask queries.
- [ ] All env vars above set in PRODUCTION with prod values; preview env
      set with non-prod (test Stripe, empty/non-prod leads, test pepper).
- [ ] Stripe: live keys swapped in; prod webhook endpoint registered at
      the prod URL in the Stripe dashboard; its signing secret set as
      STRIPE_WEBHOOK_SECRET (prod env only); webhook route reachable,
      NOT behind preview protection; a small real-money verification pass.
- [ ] Resend key + DB password rotated (chat-exposed; per pre-launch list)
      and MAIL_FROM's domain verified in Resend.
- [ ] FORM_IP_PEPPER set to a fresh prod-specific value.
- [ ] LEADS_ORGANIZATION_ID and LEADS_ALLOWED_ORIGINS set to real values
      (origin = the deployed marketing site).
- [ ] Node version: Vercel uses .nvmrc (22.22.2) or project setting;
      postinstall (nuxt prepare) runs in the Vercel build.
- [ ] Build command is the Nuxt build only — does not invoke harnesses.
- [ ] CI gate green on the deploying commit (it already gates PRs; confirm
      main is green before promoting a deploy).

After deploy, verify (the effect, both directions, per the house style):
- [ ] A page loads; a service-role route works on the prod secret key.
- [ ] Ask queries run without connection-limit errors under a burst.
- [ ] A test lead POST from the real marketing origin succeeds; from a
      disallowed origin is refused (CORS holds in prod).
- [ ] A public form submit works; the honeypot and rate limit hold.
- [ ] A real Stripe payment + its webhook reconcile (small real-money pass).
- [ ] pg_cron purges still run (they're in Supabase, unaffected by deploy —
      the verify:forms/leads outcome canaries still pass).

## Deferred / later shape

- Dedicated CI Supabase project so the verify:* harnesses can run in CI
  (currently local pre-merge only). The pre-launch env work above does not
  need it; gating DB-behavior tests in CI does.
- require-approvals on branch protection when the backend engineer joins
  (and the GitHub Team org if going private again).

## Relationship to other docs

- architecture.md — the doors; the public endpoints (Door 0 and lead
  capture) are the ones whose prod reachability + CORS matter here.
- The pre-launch list in TODO.md — its Stripe, Resend/DB-rotation and
  FORM_IP_PEPPER items are pointers to this doc (one fact, one place);
  this doc is the authoritative deployment shape and env matrix.
- ASK_DATABASE_URL / ask_readonly — the pooler decision is the deployment
  half of the ask boundary; the session-user-is-the-leash design is
  unaffected (pooler still connects as ask_readonly).
