---
name: reserve-migrations
description: Write Postgres/Supabase migrations for The Reserve in this codebase's house style — org-scoped RLS, permission seeding, append-only money rules, exclusion constraints, trigger conventions, and in-database comments. Use this whenever the task touches supabase/migrations/ or involves adding or changing a table, column, index, constraint, RLS policy, database function, trigger, permission key, or role grant — including when the user only says "add a table for X", "we need to store Y", "gate this behind a permission", "add a status field", or asks why a query is being blocked by RLS. Also use it before running npm run db:push, and when reviewing someone else's migration for convention drift.
---

# The Reserve — migrations

This project's schema is where the important rules actually live. Access
control, money integrity, and double-booking prevention are enforced by
Postgres, not by application code, on the theory that a UI bug or a rogue
API call should not be able to violate them. When you write a migration
here you are extending that guarantee surface — so the conventions below
are less about tidiness and more about not quietly opening a hole.

The depth behind the summaries here:

| File | Read it when |
| --- | --- |
| `references/rls-patterns.md` | writing any policy beyond the plain org-scoped pair |
| `references/constraints-and-triggers.md` | adding constraints, triggers, or functions |
| `references/permissions.md` | minting or granting a permission key (check the catalog first) |
| `references/design-docs.md` | the change is big enough to need a design doc |
| `assets/new_table_template.sql` | starting a new table — copy it |

## The workflow

**`npm run db:push` applies to the hosted database and is effectively
irreversible. Never run it without the user's explicit go-ahead** — not as
the natural last step of a task, not because the migration looks obviously
correct. Write the migration, show the diff, and wait. This is the single
easiest way to do real damage in this repo.

Which path a change takes depends on how much of the schema's shape it
moves.

### Schema-shape changes — draft and review first

New tables, anything touching money or ledger semantics, changes to the RLS
model, and new constraints. These get reviewed *before* the migration file
exists:

1. **Write or update a design doc in `docs/design/` first** — before the
   SQL. `migration4a-design.md` and `migration4b-design.md` are the
   pattern: a STATUS line, decisions locked from the design session *with
   their rationale*, the table shape, the integrity rules and who enforces
   each, the flows, and what is deliberately deferred. Deviations found
   while building are annotated inline as `[AS-BUILT]` rather than silently
   rewritten, so the record shows what was decided versus what survived
   contact. See `references/design-docs.md` for the other forms these take.
2. Draft the SQL and review it with the user. Several existing migrations
   still carry the header from this step
   (`-- DRAFT — Review together, then: npx supabase migration new pos_ledger`).
3. `npx supabase migration new <snake_case_name>`, paste the reviewed SQL in.
4. Show the diff, get the go-ahead, then push.

### Routine changes — straight to the migration file

Column adds, index adds, function fixes:

```bash
npx supabase migration new <snake_case_name>
```

Write the SQL into the generated
`supabase/migrations/<timestamp>_<name>.sql`, then show the diff and get the
go-ahead before pushing.

### Pushing

```bash
npm run db:push    # only with explicit approval
```

`db:push` is a chain: `supabase db push && npm run db:types && npm run db:docs`.
It applies the migration to the hosted database, regenerates
`shared/types/database.ts` from the live schema, and regenerates
`docs/schema/` via tbls. Then confirm the app still compiles against the new
types:

```bash
npx nuxt typecheck
```

Typecheck must stay at 0 errors — a schema change that breaks types is
half-finished, not done.

**Never edit a migration that has been applied.** Correct it with a new
migration instead. `20260815012250_pos_refund_fix.sql` (a 21-line function
replacement) and `20260815020903_consolidate_org_settings_permission.sql`
(retiring a duplicate permission key) are the model: small, single-purpose,
titled after the repair.

## The three rules that are never negotiable

**1. Every new table gets `organization_id` + org-scoped RLS.** No
exceptions. This is the expensive-to-retrofit layer and it is currently
100% intact — see `docs/design/multi-tenancy-status.md`. Two organizations
in this database today genuinely cannot see each other's rows. A single
table that skips it silently ends that property. Child tables that have no
natural `organization_id` (line items, participants) inherit scope through
their parent in the policy instead — see `references/rls-patterns.md`.

**2. Money is append-only.** The ledger (`transactions`,
`transaction_items`, `payments`) has no UPDATE or DELETE policies and never
will. Refunds are new transactions with negative amounts pointing at the
original via `refunds_transaction_id`. Gift cards and credits are
liabilities, not revenue. All pricing math happens in server routes, never
in the client and never trusted from the client.

**3. Append-only means "no policy exists", and it must be commented.**
Postgres denies what no policy permits, so append-only tables are created
by *omission*. That is invisible to the next reader unless you say so —
every such table carries a comment stating it. `audit_log` goes further
with an explicit `revoke update, delete on audit_log from authenticated, anon;`
as a belt-and-braces statement of intent.

## House style

Lowercase SQL keywords throughout. Banner header at the top of the file,
`-- ---` dividers between sections with SHOUTED section names, column
names aligned within a `create table`. The header names the migration and
records the command that created it:

```sql
-- ============================================================
-- Migration: internal messaging (v1: DMs + ad-hoc groups)
-- npx supabase migration new messaging
-- ============================================================
```

Columns you will write on almost every table:

```sql
create table <name> (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  ...
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),   -- only if mutable
  unique (organization_id, name)
);
```

Money is always `<thing>_cents int` with `check (>= 0)` where a negative
value would be nonsense (note the deliberate exception: discount and refund
lines *are* negative). Rates are basis points (`tax_rate_bps`, 800 = 8%).
Enums are `text` + a `check (col in (...))` constraint, never a Postgres
enum type — adding a value is then an `alter constraint`, not a type
migration (see `payments.method` gaining `stripe_card` in 4b).

Records are deactivated, never deleted: `active boolean not null default true`.
The comments say so explicitly ("Deactivated, never deleted") because it
tells the next person not to add a delete policy.

Full skeleton to copy: `assets/new_table_template.sql`.

## Comments are part of the migration, not decoration

`comment on table` / `comment on column` statements are written inline
right after each `create table`, and they surface in the Supabase
dashboard, in GUI tools, and in the generated `docs/schema/` — so they are
the schema's real documentation.

The house voice explains the **invariant and why it exists**, not the
column list:

> `'Line items with name/price SNAPSHOTS (catalog edits never rewrite sold history). kind=service carries appointment + staff attribution; kind=tip carries staff attribution for payroll reads; kind=discount is negative; kind=gift_card is a liability sale, excluded from revenue reporting.'`

Comment a column when its name under-sells it — `appointments.blocked_from`
("Start of the FULL blocked window including buffer_before — what all
conflict checks use"), `locations.tax_rate_bps`, `clients.flags`. If a rule
is enforced by a trigger or a missing policy, the comment is where a reader
finds out.

`20260814234858_schema_comments.sql` was a one-time backfill for tables
created before this habit. New tables comment themselves; don't start a
second backfill migration.

## Permissions

Permission keys are `domain.action` with optional `.own` / `.any` scope
(`appointments.view.any`, `availability.edit.own`). They are data: the
catalog lives in `permissions`, the matrix in `role_permissions`, so
changing who can do what is a data change, not a deploy.

Seed new keys and grant them in the same migration:

```sql
insert into permissions (key, description) values
  ('cards.view',   'See a client''s saved cards (brand + last4)'),
  ('cards.manage', 'Save and remove client cards on file (with consent capture)');

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join (values
  ('super_admin', 'cards.view'), ('super_admin', 'cards.manage'),
  ('admin',       'cards.view'), ('admin',       'cards.manage'),
  ('front_desk',  'cards.view'), ('front_desk',  'cards.manage')
) as p(role_name, key) on p.role_name = r.name;
```

The four system roles are `super_admin`, `admin`, `front_desk`, `provider`.

**Check the existing catalog before minting a key.** A duplicate has
already happened once: `organization.manage` was added by the business
settings migration when `org.settings.manage` already existed, and needed a
whole consolidation migration to retire. The full current catalog is in
`references/permissions.md`.

Routes assert permissions with `has_permission`, and the RPC parameter is
named `perm`:

```ts
const { data: allowed } = await userClient.rpc("has_permission", { perm: "pos.refund" });
```

## RLS

Enable RLS on every new table in one aligned block, then write policies.
The canonical org-scoped pair:

```sql
alter table products enable row level security;

create policy products_read on products
  for select using (organization_id = current_org_id() and has_permission('products.view'));
create policy products_manage on products
  for all using (organization_id = current_org_id() and has_permission('products.manage'));
```

Policies are named `<table>_read` / `<table>_manage` / `<table>_insert` /
`<table>_update` / `<table>_delete`. The three helper functions every policy
is built from — `current_org_id()`, `current_staff_id()`, `has_permission(perm)` —
are `security definer stable` and defined in migration 1.

Four more shapes you will need — child-table scoping through a parent,
own/any permission scopes, self-service with a column guard trigger, and
recursion-safe membership checks — are in `references/rls-patterns.md`.
Read it before writing any policy that is not the simple org-scoped pair.

**Deciding whether to write an INSERT policy at all** is the important
judgment call. Direct client writes are fine for simple owned records. But
when an operation is multi-step, needs server-side pricing, or calls an
external API mid-flight (checkout, refunds, Stripe card saves, invite
acceptance), the table gets *no* authenticated insert policy and the work
happens in a server route under the service role — with a comment saying
that's the design. RLS then can't be the thing that's wrong.

## Constraints, triggers, and functions

The database enforces the rules that must not be violable:

- **Exclusion constraints** make double-booking impossible even under
  concurrent inserts (`no_staff_double_booking`, `no_room_double_booking`,
  `no_overlapping_hours`). They need `btree_gist`, already installed.
- **Table-level check constraints** carry cross-column invariants:
  `check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents)`,
  `check (starts_at < ends_at)`, and the presence-pairing idiom
  `check ((method = 'gift_card') = (gift_card_id is not null))`.
- **Triggers** maintain derived state (`maintain_no_show_count`,
  gift-card balances, product stock), enforce protections
  (`prevent_last_super_admin_removal`, `guard_staff_self_update`), and fire
  notifications — deliberately at the database level so that manual SQL and
  any future UI are covered too.
- **Functions** are `language sql|plpgsql security definer set search_path = public`,
  `stable` for read-only helpers. Service-role-only functions are locked
  down with `revoke execute ... from public, anon, authenticated`.

Naming: triggers `trg_<subject>`, `trg_<table>_touch` for the shared
`touch_updated_at()`. Functions read as verbs — `apply_`, `notify_`,
`maintain_`, `guard_`, `prevent_`, `audit_`, `find_or_create_`.

**Every new function prefixes its parameters with `p_`** (`p_conversation_id`,
`p_staff_ids`). Older migrations use bare names; don't copy them. The
prefix stops a parameter from shadowing a column — a shadow silently
changes what a `where` clause means — and, just as importantly, it makes
the parameter name predictable at the call site. `has_permission(perm)` is
the one grandfathered exception, because it is referenced by every RLS
policy and several server routes; renaming it is a schema-wide change, not
a cleanup.

That exception has already cost real debugging time: calling it as
`p_key` instead of `perm` produced silent 403s on every refund, caught in
the 4a gauntlet. Which is the rule the whole convention exists to prevent —
and the reason for the corollary: **when calling any RPC from TypeScript,
`shared/types/database.ts` is the authority on parameter names.** It is
regenerated by `db:push` from the live schema. Read it; never type an RPC
parameter from memory.

Details, gotchas (including the 42P17 RLS recursion trap and why SELECTs
can't be audited by trigger), and copy-ready examples:
`references/constraints-and-triggers.md`.

## Idempotency

Default to writing plain, non-idempotent SQL — a migration runs once.

Reach for `if not exists` / `on conflict do nothing` / `drop policy if
exists` only when a change was already applied by hand to the live database
(via the SQL editor) and the migration has to no-op there while applying
cleanly to a fresh one.

**A guard without its explanation is a convention violation.** When you use
one, the header comment saying what was hand-applied and when — ideally
naming the incident — is mandatory, not a nicety. The guards are a signal
that carries information ("this already ran on live"); unexplained, they
degrade into noise and the next reader can no longer tell history from
superstition. The two existing examples show the form:

```sql
-- Migration: business settings (idempotent rerun after partial apply)
```

```sql
-- Consolidates the accidental duplicate permission: 'organization.manage'
-- (minted in business_settings) retires in favor of migration 1's
-- 'org.settings.manage'. Applied manually via SQL editor on live first;
-- written idempotently so it no-ops there and applies cleanly on fresh DBs.
```

## Before you call it done

Before asking for the go-ahead:

- design doc in `docs/design/` written or updated, if this was a
  schema-shape change
- `organization_id` + RLS enabled + policies written (or a comment
  explaining why writes go through a server route instead)
- append-only intent stated in a comment where policies are deliberately absent
- `comment on table` written, plus columns whose names under-sell them
- new permission keys seeded *and* granted to roles, with no duplicate of
  an existing key
- indexes for the queries the feature will actually run (partial indexes
  where the filter is constant: `where active`, `where read_at is null`)
- if the table should stream to the UI: `alter publication supabase_realtime add table <t>;`
- any idempotency guard carries its header comment explaining what was
  hand-applied
- diff shown to the user

After approval and `npm run db:push`:

- `npx nuxt typecheck` still at 0
- new/changed RPC signatures re-read from the regenerated
  `shared/types/database.ts` before any call site is written
