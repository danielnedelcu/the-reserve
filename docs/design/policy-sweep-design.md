# The policy sweep — helpers evaluated once, and the ledger's own `organization_id`

STATUS: design approved 2026-10-08 with the rulings below; PR 1 (the wrap and the guard) in build.

## Why

Every RLS policy in the schema was written as `organization_id =
current_org_id() and has_permission('…')`. Postgres evaluates those
calls PER ROW: the server-tables benchmark measured a bare
`select count(*)` over 10,000 clients at 255ms, and 0.7ms once the two
calls were wrapped as `(select current_org_id())` and
`(select has_permission('…'))`, which the planner runs once per
statement as an InitPlan — same truth value, same rows
(docs/design/server-tables-design.md, decision 1 `[AS-BUILT]`). The
clients, products, transactions, items, payments and gift-card policies
were fixed that way as the tables work needed them. Everything else
still pays the per-row cost, and the ledger's two line tables pay a
second one: their policies look up the parent transaction PER LINE,
because the lines carry no `organization_id` of their own — about 90ms
of every year-wide `transactions_page` call, which now sits near its
budget (p50 178–385ms, max 763ms against 400 / 800).

## Stop 1: the inventory (hosted `pg_policies`, 2026-10-08)

84 policies on 47 tables with RLS enabled. Three more RLS tables carry
no policy at all and are reached by the service role only
(`campaign_unsubscribe_tokens`, `cancellation_tokens`, `stripe_events`),
which is the designed shape for token and webhook tables.

| Category | Count | What |
| --- | --- | --- |
| 1. Already wrapped | 8 | `clients` ×4, `products` ×2, `transactions_read`, `gift_cards_read` |
| 2. Mechanical | 45 | call `current_org_id()`, `has_permission()`, `current_staff_id()`, `auth.uid()` or `is_admin()` per row, with no subquery on another table; wrapping is the whole fix (Appendix A, every USING and WITH CHECK) |
| 3. Structural | 27 | an `exists (select 1 from <parent> …)` per row (Appendix B); the helpers inside it are wrapped too, which hoists them out of the correlated subquery, but the parent lookup stays until the child carries the organisation itself |
| 4. Unusual | 4 | below |

Helpers: `current_org_id`, `current_staff_id`, `has_permission`,
`is_admin` and `is_conversation_participant` are all STABLE and
SECURITY DEFINER, so hoisting a call with no row reference into an
InitPlan is exactly the planner's own rule for stable functions, and
the value cannot differ between rows of one statement.

### The structural 27, and whether a column would make them plain

| Child table (rows hosted) | Parent it looks up | A denormalised `organization_id` would make it a plain column check? | Verdict |
| --- | --- | --- | --- |
| `transaction_items` (18), `payments` (13) | `transactions` | Yes: the policy becomes `organization_id = (select current_org_id()) and (select has_permission('transactions.view'))`, the same shape as `transactions_read`. Grows with every sale; measured at ~90ms per year-wide call. | **Do it** (PR 2) |
| `appointment_services` (6) | `appointments` | Only partly: the `exists` also re-applies the parent's own-versus-any rule (`a.staff_id = current_staff_id()`), which a column cannot carry. Grows with bookings; the schedule reads it for every card. | Wrap the helpers now; revisit with a benchmark on seeded appointments (optional, below) |
| `availability_rules` (5), `availability_exceptions`, `staff_locations`, `staff_roles` | `staff` | Yes, but these are roster-sized configuration tables read a few rows at a time. | Wrap only |
| `role_permissions` (108) | `roles` | Yes; 108 rows, read once per session by `get_my_permissions`. | Wrap only |
| `service_staff`, `service_resource_requirements` | `services` | Yes; catalogue-sized. | Wrap only |
| `resources` | `locations` | Yes; a handful of rooms. | Wrap only |
| `client_notes`, `lead_notes` | `clients`, `leads` | Yes, but `client_notes` is the PHI table whose policy is deliberately the most conservative in the schema; nothing reads it in bulk. | Wrap only |
| `form_versions` (5), `form_response_health` (3) | `form_definitions`, `form_responses` | Yes; small, and `form_response_health` is a health table under the same reasoning as `client_notes`. | Wrap only |

### The unusual 4

- `conversations_read`, `participants_read`, `messages_read`: `is_conversation_participant(conversation_id)` takes the row's own column, so it is correlated by design and cannot be hoisted. It is one indexed lookup per row on a per-person table. **Ruled 2026-10-08: no uncorrelated rewrite.** `participants_read` cannot select from its own table without recursing — that recursion is the reason the helper exists — and for `conversations_read` and `messages_read` an `in (select … from conversation_participants …)` would read that table under its own policy, calling the helper per row anyway. All three stay correlated and are the guard's allowlist, each with that reason; `messages_send` keeps the same correlated call in its WITH CHECK (one row) and gets its `current_staff_id()` wrapped.
- `permissions_read`: `using (true)`, a reference table. Correct as is.
- `audit_read`: `has_permission('audit_log.view')` with NO organisation term, because `audit_log` has no `organization_id`. Any holder of `audit_log.view` in any organisation can read every organisation's audit rows through the API. Out of this sweep's scope and not caused by it: **ruled 2026-10-08 as its own PR, immediately after PR 1 and before the Vercel deploy** — a cross-tenant read, not a performance item. Its design must say how the backfill runs (`audit_log` is append-only by REVOKE on the API roles, not by trigger, so the migration's UPDATE as postgres is allowed and is recorded as the one-time backfill), give a rule for rows with no staff actor (system- and job-written rows: the organisation comes from the entity the row describes, through `entity_type`/`entity_id`, else from the job's organisation argument, and a row with neither is reported, not guessed), add the organisation term to the policy, and prove it with a two-organisation harness case that one organisation cannot read another's audit rows.
- `staff_self_update`: `user_id = auth.uid()`, the one policy on `auth.uid()` directly; wrapped like the rest.

## The mechanical wrap (PR 1)

One migration, `policies_evaluate_once`, in the shape of
`20261006224905_clients_policies_evaluate_once`: `alter policy … using
(…)` and `alter policy … with check (…)` for every clause in Appendix
A and every clause in Appendix B, each restated clause for clause with
only the helper calls wrapped. `alter policy` leaves an unnamed clause
untouched, so a policy with only USING keeps its implied WITH CHECK
(for `ALL` policies Postgres applies USING as the check when none is
given, before and after). No policy is dropped, renamed or re-scoped;
no table gains or loses a policy. Delete behaviour: none.

### The guard

`scripts/verify-policies.mjs`, run in the CI database job beside the
other harnesses and against hosted by hand: it reads `pg_policies` for
every table in `public` and fails, naming the table, policy and clause,
on any occurrence of `current_org_id(`, `current_staff_id(`,
`has_permission(`, `is_admin(` or `auth.uid(` that is not immediately
inside `( select … )` in either the USING or the WITH CHECK
expression. An allowlist, each entry with a one-line reason, covers
only `is_conversation_participant(` (correlated by design); an
allowlist entry whose policy no longer matches fails too, as the
browser-clock guard does. It also fails if any table with RLS enabled
has zero policies and is not in the service-role-only list above, so a
new table cannot ship open by omission. The same idea as
`tests/guards/browserClock.test.ts`: the next policy written the old
way fails the suite instead of shipping a per-row cost.

## The ledger's `organization_id` (PR 2)

### The columns and the structural guarantee

```sql
alter table transactions add constraint transactions_id_org_unique unique (id, organization_id);
alter table transaction_items add column organization_id uuid;
alter table payments          add column organization_id uuid;
-- backfill (below), then:
alter table transaction_items alter column organization_id set not null,
  add constraint transaction_items_transaction_org_fkey
    foreign key (transaction_id, organization_id)
    references transactions (id, organization_id) on delete restrict;
alter table payments alter column organization_id set not null,
  add constraint payments_transaction_org_fkey
    foreign key (transaction_id, organization_id)
    references transactions (id, organization_id) on delete restrict;
```

The composite foreign key is the consistency rule: a line whose
`organization_id` differs from its transaction's cannot exist, by
reference, with no trigger to keep right. The existing single-column
keys stay (they carry the `restrict` on the parent); the unique
constraint on `(id, organization_id)` exists only so the composite key
has something to reference. The columns get the same partial index
the parent uses for its reads, `(organization_id, transaction_id)`.

### The backfill — the one sanctioned exception

The ledger is append-only for every role by `ledger_block_change`
(ledger-integrity-design.md), and a backfill is an UPDATE. The
migration, which Supabase applies inside one transaction, disables the
two tables' append-only triggers by name, runs the one UPDATE each
from the parent (`set organization_id = t.organization_id from
transactions t where t.id = transaction_id`), re-enables them, and
asserts in the same transaction that both are enabled again
(`pg_trigger.tgenabled = 'O'`) and that no row is left null — a
`raise exception` on either rolls the whole migration back. The
migration header records it as the deliberate one-time exception, the
only UPDATE the ledger has had since `legacy:` keys, and the design
doc's `[AS-BUILT]` notes it. `session_replication_role = replica` is
not used: it would also skip the foreign-key checks.

Proof that the triggers are back: `verify-ledger` already refuses an
update and a delete on all three tables under the service role; it
gains a case that reads `pg_trigger` and asserts the three append-only
triggers and the three balance triggers are enabled (`'O'`), so a
future migration that disables one and forgets cannot pass.

### The writers, the view, the policies

- `write_ledger_transaction` sets `organization_id = p_organization_id`
  on every line and payment it inserts; it already refuses rows from
  another organisation, and the composite key now makes the mismatch
  impossible rather than checked.
- The harness fixtures and the load seed (`verify-tables`,
  `verify-presets`, `verify-ledger`, `seed-tables-load`) insert the
  column.
- `ledger_lines` and `ledger_transactions` keep their shape;
  `ledger_lines.organization_id` reads the line's own column.
- `transaction_items_read` and `payments_read` become
  `using (organization_id = (select current_org_id()) and (select
  has_permission('transactions.view')))` — the plain column check,
  `transactions_read`'s shape — and the per-line parent lookup is gone.

## Proof

- **Same meaning.** Every harness and every journey passes unchanged
  before and after each PR: verify-tables (95, with its two-organisation
  cases on clients, products and transactions), verify-ledger (51),
  verify-presets (34, with the second organisation's lines never
  appearing in the first's view), verify-forms, verify-ask, verify-leads,
  verify-messages (43, the conversation policies), and the 11 journeys.
  The sweep adds no new semantic claim, so no new semantic case: the
  claim is that nothing changed, and the existing cases are the ones
  that would notice.
- **The guard** passes after PR 1 and fails on a policy written the old
  way (proven once by running it against a copy of the pre-sweep schema
  on the local stack before the migration is applied).
- **Benchmark.** `bench:tables` on the full seed before and after each
  PR: the year window (the ledger lines' parent lookup) is the figure PR
  2 exists to move; the month window and the clients and products cases
  must not regress. For a representative non-ledger table under the
  mechanical wrap, the seed gains appointments (one per seeded service
  line, 50,000, under the seeded providers) and the benchmark a
  "schedule month" case on `appointments_read` through a bare count and
  the schedule's own select as a provider session, which exercises the
  own-versus-any branch. **Ruled 2026-10-08: yes**, including the
  provider session, and `appointment_services`' numbers are recorded
  here so the decision on its column has data.
- **Schema comparison** at zero differences after each hosted push, and
  the hosted invariant queries re-run before PR 2's push.

## PR 1 as built (2026-10-08, migration 20261008033713_policies_evaluate_once)

`[AS-BUILT]` 70 `alter policy` statements, generated from the hosted
`pg_policies` expressions and reviewed clause for clause (Appendix A and
B). `scripts/verify-policies.mjs` failed on the pre-wrap schema naming
exactly those 70 policies (and nothing else) and passes after it; it
runs in the CI database job. The allowlist has four entries, not three:
`messages_send`'s WITH CHECK carries the same correlated
`is_conversation_participant(conversation_id)` as the three reads, and
its entry allows only that call (its `current_staff_id()` is wrapped).
The migration's header comment says "three" and "allowlists exactly
those three"; the guard allowlists four. The comment was not corrected:
the correction failed silently in a command chain that went on to push
the file to hosted, and applied migrations are never edited. The count
that is right is this one, the guard's and the PR's.

**Benchmark, full seed** (10,000 clients, 2,000 products, 50,000
transactions, and now 50,000 appointments with one service line each:
the five seeded providers back to back, hourly, over fourteen months),
`bench:tables` with four new schedule cases run as raw SQL under the
policies: a month of appointments as an admin (`appointments.view.any`)
and as a provider whose bench-made role holds `appointments.view.own`
ONLY (the seeded provider role also holds view.any, which would take
the other branch), and the same month's `appointment_services` as each.
The provider sees 720 of the month's 3,600 rows, which is the own
branch running.

| Case (month budget p50 ≤ 50ms, max ≤ 200ms) | Before the wrap | After |
| --- | --- | --- |
| appointments, admin (view.any) | p50 119ms, max 252ms — OVER | p50 2.2ms, max 3.8ms |
| appointments, provider (view.own) | p50 294ms, max 365ms — OVER | p50 2.5ms, max 2.6ms |
| appointment_services, admin | p50 255ms, max 450ms — OVER | p50 6.7ms, max 8.1ms |
| appointment_services, provider | p50 440ms, max 650ms — OVER | p50 4.9ms, max 5.1ms |

So the schedule's reads were over budget before this PR by a factor of
two to nine, and the per-row helper calls were the whole cost: the
provider's own branch paid `current_staff_id()` per row on top of the
other two. `appointment_services` after the wrap still carries its
`exists` on the parent (the own-versus-any rule a column cannot carry),
and at 5 to 7ms for a month it does not earn a column; the decision
recorded here is to leave it as the wrapped `exists`. The ledger year
window is unchanged by PR 1, as expected (p50 337 to 340ms before and
after; PR 2 is what moves it). Every harness and every journey passed
unchanged before and after: the sweep changed no policy's meaning.

## The split

- **PR 1 — the mechanical wrap and the guard.** Appendix A and B
  clauses (70 `alter policy` statements: the 45 mechanical and 25 of the
  27 structural; `payments_read` and `transaction_items_read` were
  wrapped in server-tables PR 3), `verify-policies` in CI, the
  `audit_log` finding on the board. One migration, no column change,
  every harness and journey as the proof.
- **The `audit_log` organisation column** — its own PR, after PR 1 and
  before the Vercel deploy (ruling 3 above).
- **PR 2 — the ledger's `organization_id`.** The columns, the composite
  key, the backfill with its recorded exception and its trigger-enabled
  assertion, the write function, the fixtures and seed, the view, the
  two policies, the year benchmark before and after.
- `appointment_services` and the other structural tables stay as
  wrapped `exists` lookups, with the appointments benchmark deciding
  whether `appointment_services` earns a column later.

## Deliberately deferred

- Columns on the configuration-sized structural tables.
- The `audit_log` organisation column (its own board item: a column, a
  backfill from the actor's staff row, and the policy).
- Any change to what a policy means.
## Appendix A — the mechanical wrap, clause for clause

| Table | Policy | Cmd | Clause | As it stands | After |
| --- | --- | --- | --- | --- | --- |
| `appointments` | `appointments_insert` | INSERT | WITH CHECK | `((organization_id = current_org_id()) and has_permission('appointments.create') and (booked_by = current_staff_id()))` | `((organization_id = (select current_org_id())) and (select has_permission('appointments.create')) and (booked_by = (select current_staff_id())))` |
| `appointments` | `appointments_read` | SELECT | USING | `((organization_id = current_org_id()) and (has_permission('appointments.view.any') or (has_permission('appointments.view.own') and (staff_id = current_staff_id()))))` | `((organization_id = (select current_org_id())) and ((select has_permission('appointments.view.any')) or ((select has_permission('appointments.view.own')) and (staff_id = (select current_staff_id())))))` |
| `appointments` | `appointments_update` | UPDATE | USING | `((organization_id = current_org_id()) and (has_permission('appointments.edit.any') or (has_permission('appointments.edit.own') and (staff_id = current_staff_id()))))` | `((organization_id = (select current_org_id())) and ((select has_permission('appointments.edit.any')) or ((select has_permission('appointments.edit.own')) and (staff_id = (select current_staff_id())))))` |
| `ask_queries` | `ask_queries_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('ask.query'))` | `((organization_id = (select current_org_id())) and (select has_permission('ask.query')))` |
| `audit_log` | `audit_read` | SELECT | USING | `has_permission('audit_log.view')` | `(select has_permission('audit_log.view'))` |
| `availability_exceptions` | `availability_exceptions_update` | UPDATE | USING | `(has_permission('timeoff.approve') or ((staff_id = current_staff_id()) and (status = 'requested')))` | `((select has_permission('timeoff.approve')) or ((staff_id = (select current_staff_id())) and (status = 'requested')))` |
| `campaign_recipients` | `campaign_recipients_read` | SELECT | USING | `((organization_id = current_org_id()) and is_admin())` | `((organization_id = (select current_org_id())) and (select is_admin()))` |
| `campaigns` | `campaigns_manage` | ALL | USING | `((organization_id = current_org_id()) and is_admin())` | `((organization_id = (select current_org_id())) and (select is_admin()))` |
| `card_consents` | `card_consents_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('cards.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('cards.view')))` |
| `client_payment_methods` | `client_payment_methods_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('cards.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('cards.view')))` |
| `communications_sent` | `communications_sent_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('clients.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('clients.view')))` |
| `conversation_participants` | `participants_update_own` | UPDATE | USING | `(staff_id = current_staff_id())` | `(staff_id = (select current_staff_id()))` |
| `form_definitions` | `form_definitions_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('forms.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.manage')))` |
| `form_definitions` | `form_definitions_read` | SELECT | USING | `((organization_id = current_org_id()) and (has_permission('forms.manage') or has_permission('forms.send') or has_permission('forms.responses.view')))` | `((organization_id = (select current_org_id())) and ((select has_permission('forms.manage')) or (select has_permission('forms.send')) or (select has_permission('forms.responses.view'))))` |
| `form_links` | `form_links_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('forms.send'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.send')))` |
| `form_links` | `form_links_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('forms.send'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.send')))` |
| `form_responses` | `form_responses_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('forms.responses.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')))` |
| `form_submission_attempts` | `form_submission_attempts_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('audit_log.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('audit_log.view')))` |
| `leads` | `leads_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('leads.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('leads.manage')))` |
| `leads` | `leads_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('leads.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('leads.view')))` |
| `locations` | `locations_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('org.settings.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('org.settings.manage')))` |
| `locations` | `locations_read` | SELECT | USING | `(organization_id = current_org_id())` | `(organization_id = (select current_org_id()))` |
| `messages` | `messages_send` | INSERT | WITH CHECK | `((sender_staff_id = current_staff_id()) and is_conversation_participant(conversation_id))` | `((sender_staff_id = (select current_staff_id())) and is_conversation_participant(conversation_id))` |
| `notifications` | `notifications_read` | SELECT | USING | `(staff_id = current_staff_id())` | `(staff_id = (select current_staff_id()))` |
| `notifications` | `notifications_update` | UPDATE | USING | `(staff_id = current_staff_id())` | `(staff_id = (select current_staff_id()))` |
| `organizations` | `org_manage` | UPDATE | USING | `((id = current_org_id()) and has_permission('org.settings.manage'))` | `((id = (select current_org_id())) and (select has_permission('org.settings.manage')))` |
| `organizations` | `org_read` | SELECT | USING | `(id = current_org_id())` | `(id = (select current_org_id()))` |
| `organizations` | `organizations_settings_manage` | UPDATE | USING | `((id = current_org_id()) and has_permission('org.settings.manage'))` | `((id = (select current_org_id())) and (select has_permission('org.settings.manage')))` |
| `prospect_intake` | `prospect_intake_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('forms.responses.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')))` |
| `prospect_intake` | `prospect_intake_update` | UPDATE | USING | `((organization_id = current_org_id()) and has_permission('forms.responses.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')))` |
| `prospect_intake` | `prospect_intake_update` | UPDATE | WITH CHECK | `((organization_id = current_org_id()) and has_permission('forms.responses.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')))` |
| `resource_types` | `resource_types_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('services.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.manage')))` |
| `resource_types` | `resource_types_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('services.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.view')))` |
| `roles` | `roles_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('roles.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('roles.manage')))` |
| `roles` | `roles_read` | SELECT | USING | `(organization_id = current_org_id())` | `(organization_id = (select current_org_id()))` |
| `service_categories` | `categories_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('services.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.manage')))` |
| `service_categories` | `categories_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('services.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.view')))` |
| `services` | `services_manage` | ALL | USING | `((organization_id = current_org_id()) and has_permission('services.manage'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.manage')))` |
| `services` | `services_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('services.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('services.view')))` |
| `staff` | `staff_insert` | INSERT | WITH CHECK | `((organization_id = current_org_id()) and has_permission('staff.invite'))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.invite')))` |
| `staff` | `staff_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('staff.view'))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.view')))` |
| `staff` | `staff_self_update` | UPDATE | USING | `(user_id = auth.uid())` | `(user_id = (select auth.uid()))` |
| `staff` | `staff_update` | UPDATE | USING | `((organization_id = current_org_id()) and has_permission('staff.edit'))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.edit')))` |
| `staff_invites` | `invites_create` | INSERT | WITH CHECK | `((organization_id = current_org_id()) and has_permission('staff.invite') and (invited_by = current_staff_id()))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.invite')) and (invited_by = (select current_staff_id())))` |
| `staff_invites` | `invites_read` | SELECT | USING | `((organization_id = current_org_id()) and has_permission('staff.invite'))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.invite')))` |
| `staff_invites` | `invites_revoke` | UPDATE | USING | `((organization_id = current_org_id()) and has_permission('staff.invite'))` | `((organization_id = (select current_org_id())) and (select has_permission('staff.invite')))` |

## Appendix B — the structural policies, helpers wrapped (the `exists` stays until the column lands)

| Table | Policy | Cmd | Clause | As it stands | After |
| --- | --- | --- | --- | --- | --- |
| `appointment_services` | `appointment_services_read` | SELECT | USING | `(exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = current_org_id()) and (has_permission('appointments.view.any') or (has_permission('appointments.view.own') and (a.staff_id = current_staff_id()))))))` | `(exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = (select current_org_id())) and ((select has_permission('appointments.view.any')) or ((select has_permission('appointments.view.own')) and (a.staff_id = (select current_staff_id())))))))` |
| `appointment_services` | `appointment_services_write` | ALL | USING | `(exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = current_org_id()) and (has_permission('appointments.edit.any') or (has_permission('appointments.edit.own') and (a.staff_id = current_staff_id()))))))` | `(exists (select 1 from appointments a where ((a.id = appointment_services.appointment_id) and (a.organization_id = (select current_org_id())) and ((select has_permission('appointments.edit.any')) or ((select has_permission('appointments.edit.own')) and (a.staff_id = (select current_staff_id())))))))` |
| `availability_exceptions` | `availability_exceptions_insert` | INSERT | WITH CHECK | `((created_by = current_staff_id()) and (exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = current_org_id())))) and (has_permission('availability.edit.any') or ((staff_id = current_staff_id()) and has_permission('timeoff.request'))))` | `((created_by = (select current_staff_id())) and (exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = (select current_org_id()))))) and ((select has_permission('availability.edit.any')) or ((staff_id = (select current_staff_id())) and (select has_permission('timeoff.request')))))` |
| `availability_exceptions` | `availability_exceptions_read` | SELECT | USING | `(exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = current_org_id()))))` | `(exists (select 1 from staff s where ((s.id = availability_exceptions.staff_id) and (s.organization_id = (select current_org_id())))))` |
| `availability_rules` | `availability_rules_read` | SELECT | USING | `(exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = current_org_id()))))` | `(exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = (select current_org_id())))))` |
| `availability_rules` | `availability_rules_write` | ALL | USING | `((exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = current_org_id())))) and (has_permission('availability.edit.any') or (has_permission('availability.edit.own') and (staff_id = current_staff_id()))))` | `((exists (select 1 from staff s where ((s.id = availability_rules.staff_id) and (s.organization_id = (select current_org_id()))))) and ((select has_permission('availability.edit.any')) or ((select has_permission('availability.edit.own')) and (staff_id = (select current_staff_id())))))` |
| `client_notes` | `client_notes_insert` | INSERT | WITH CHECK | `((author_id = current_staff_id()) and (((kind = 'health') and has_permission('clients.notes.health.create')) or ((kind <> 'health') and has_permission('clients.view'))) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = current_org_id())))))` | `((author_id = (select current_staff_id())) and (((kind = 'health') and (select has_permission('clients.notes.health.create'))) or ((kind <> 'health') and (select has_permission('clients.view')))) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = (select current_org_id()))))))` |
| `client_notes` | `client_notes_read` | SELECT | USING | `(has_permission('clients.view') and ((kind <> 'health') or has_permission('clients.notes.health.view')) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = current_org_id())))))` | `((select has_permission('clients.view')) and ((kind <> 'health') or (select has_permission('clients.notes.health.view'))) and (exists (select 1 from clients c where ((c.id = client_notes.client_id) and (c.organization_id = (select current_org_id()))))))` |
| `form_response_health` | `form_response_health_read` | SELECT | USING | `(exists (select 1 from form_responses r where ((r.id = form_response_health.form_response_id) and (r.organization_id = current_org_id()) and has_permission('forms.responses.view') and has_permission('clients.notes.health.view'))))` | `(exists (select 1 from form_responses r where ((r.id = form_response_health.form_response_id) and (r.organization_id = (select current_org_id())) and (select has_permission('forms.responses.view')) and (select has_permission('clients.notes.health.view')))))` |
| `form_versions` | `form_versions_insert` | INSERT | WITH CHECK | `(exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = current_org_id()) and has_permission('forms.manage'))))` | `(exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = (select current_org_id())) and (select has_permission('forms.manage')))))` |
| `form_versions` | `form_versions_read` | SELECT | USING | `(exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = current_org_id()) and (has_permission('forms.manage') or has_permission('forms.send') or has_permission('forms.responses.view')))))` | `(exists (select 1 from form_definitions d where ((d.id = form_versions.form_definition_id) and (d.organization_id = (select current_org_id())) and ((select has_permission('forms.manage')) or (select has_permission('forms.send')) or (select has_permission('forms.responses.view'))))))` |
| `lead_notes` | `lead_notes_insert` | INSERT | WITH CHECK | `((staff_id = current_staff_id()) and has_permission('leads.manage') and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = current_org_id())))))` | `((staff_id = (select current_staff_id())) and (select has_permission('leads.manage')) and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = (select current_org_id()))))))` |
| `lead_notes` | `lead_notes_read` | SELECT | USING | `(has_permission('leads.view') and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = current_org_id())))))` | `((select has_permission('leads.view')) and (exists (select 1 from leads l where ((l.id = lead_notes.lead_id) and (l.organization_id = (select current_org_id()))))))` |
| `payments` | `payments_read` | SELECT | USING | `((exists (select 1 from transactions t where ((t.id = payments.transaction_id) and (t.organization_id = (select current_org_id()))))) and (select has_permission('transactions.view')))` | `((exists (select 1 from transactions t where ((t.id = payments.transaction_id) and (t.organization_id = (select current_org_id()))))) and (select has_permission('transactions.view')))` |
| `resources` | `resources_manage` | ALL | USING | `(has_permission('services.manage') and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = current_org_id())))))` | `((select has_permission('services.manage')) and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = (select current_org_id()))))))` |
| `resources` | `resources_read` | SELECT | USING | `(has_permission('services.view') and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = current_org_id())))))` | `((select has_permission('services.view')) and (exists (select 1 from locations l where ((l.id = resources.location_id) and (l.organization_id = (select current_org_id()))))))` |
| `role_permissions` | `role_permissions_manage` | ALL | USING | `(has_permission('roles.manage') and (exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = current_org_id())))))` | `((select has_permission('roles.manage')) and (exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = (select current_org_id()))))))` |
| `role_permissions` | `role_permissions_read` | SELECT | USING | `(exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = current_org_id()))))` | `(exists (select 1 from roles r where ((r.id = role_permissions.role_id) and (r.organization_id = (select current_org_id())))))` |
| `service_resource_requirements` | `srr_manage` | ALL | USING | `(has_permission('services.manage') and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('services.manage')) and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = (select current_org_id()))))))` |
| `service_resource_requirements` | `srr_read` | SELECT | USING | `(has_permission('services.view') and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('services.view')) and (exists (select 1 from services s where ((s.id = service_resource_requirements.service_id) and (s.organization_id = (select current_org_id()))))))` |
| `service_staff` | `service_staff_manage` | ALL | USING | `(has_permission('services.manage') and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('services.manage')) and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = (select current_org_id()))))))` |
| `service_staff` | `service_staff_read` | SELECT | USING | `(has_permission('services.view') and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('services.view')) and (exists (select 1 from services s where ((s.id = service_staff.service_id) and (s.organization_id = (select current_org_id()))))))` |
| `staff_locations` | `staff_locations_manage` | ALL | USING | `(has_permission('staff.edit') and (exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('staff.edit')) and (exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = (select current_org_id()))))))` |
| `staff_locations` | `staff_locations_read` | SELECT | USING | `(exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = current_org_id()))))` | `(exists (select 1 from staff s where ((s.id = staff_locations.staff_id) and (s.organization_id = (select current_org_id())))))` |
| `staff_roles` | `staff_roles_manage` | ALL | USING | `(has_permission('roles.manage') and (exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = current_org_id())))))` | `((select has_permission('roles.manage')) and (exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = (select current_org_id()))))))` |
| `staff_roles` | `staff_roles_read` | SELECT | USING | `(exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = current_org_id()))))` | `(exists (select 1 from staff s where ((s.id = staff_roles.staff_id) and (s.organization_id = (select current_org_id())))))` |
| `transaction_items` | `transaction_items_read` | SELECT | USING | `((exists (select 1 from transactions t where ((t.id = transaction_items.transaction_id) and (t.organization_id = (select current_org_id()))))) and (select has_permission('transactions.view')))` | `((exists (select 1 from transactions t where ((t.id = transaction_items.transaction_id) and (t.organization_id = (select current_org_id()))))) and (select has_permission('transactions.view')))` |
