# Ask The Reserve — AI query layer: Design

STATUS: PHASE 1 APPLIED 2026-08-30. Both migrations are on the hosted
database and the safety boundary is verified against it (see Verification
below). The free-text path is built but has never executed — it needs
ANTHROPIC_API_KEY — so the feature is not yet end-to-end live.
This document records the design as decided and built. Decisions were
locked in the 2026-08-30 session; the pre-design capture that fed it is
preserved in `ask-the-reserve-notes.md`. Deviations found during the
build are noted inline as [AS-BUILT].

Phase 1 is the text-to-SQL half only. The pgvector/semantic half still
waits on intake forms (§6) producing a corpus — see the notes doc.

## Decisions locked from Q&A

1. **Execution: a dedicated connection whose session user is the role.**
   `/api/ask` opens its own Postgres connection as `ask_readonly` (LOGIN,
   NOINHERIT, no memberships, `connection limit 5`), with
   `default_transaction_read_only` and `statement_timeout` set at the
   role level. The asking admin's identity is injected as
   `request.jwt.claims` so the RLS helpers resolve to them.

   **The principle: execution runs on a session whose session_user is the
   leash — never role-switching within a privileged session.**

   [AS-BUILT] This was adjudicated once, built the other way, and
   bounced in review. The rejected design was a SECURITY INVOKER
   function running `set local role ask_readonly` on the app's normal
   connection, on the reasoning that a role escape would land at
   `authenticated` and so grant nothing new. That reasoning was wrong on
   one word. Under PostgREST the session user is not `authenticated` but
   **`authenticator`**, which holds membership in anon, authenticated
   AND service_role — that membership is precisely how PostgREST
   switches roles. Role-change privilege is checked against the session
   user, so a generated statement containing
   `set_config('role','service_role',true)` escalates past the role
   switch, the allowlist, and the client_notes exclusion in one step.
   Worse, as a function call inside a SELECT it satisfies any
   single-statement or SELECT-prefix check placed in front of it, so the
   shape checks provide no cover at all.

   The password is provisioned outside the migration (`ASK_DATABASE_URL`),
   because secrets do not belong in migration files. Until it is set the
   role cannot authenticate, so a half-finished setup fails closed.

2. **The allowlist is grants, not string matching.** `ask_readonly` holds
   SELECT on 18 structured tables and nothing else. No code anywhere in
   this feature inspects SQL to decide what may be read. Prompt
   hardening is defense in depth on top; it is never the boundary.

3. **client_notes is not granted at all in v1.** Health-tier notes are
   PHI. Note-text questions belong to the semantic phase, which will
   carry its own privacy design. If a note-text need arrives early, the
   documented fallback is a `kind <> 'health'` VIEW — never the table.
   Also ungranted: messages/conversations (private staff comms, excluded
   from every corpus by standing decision), staff_invites (live tokens),
   the Stripe identity tables, audit_log, and ask_queries itself.

4. **No summarization in v1 — result rows never leave the database.**
   The LLM call happens BEFORE execution (question + schema → SQL) and
   never after. The categorical claim "client data never leaves the
   database" is worth more than prose answers, and it follows the
   precedent 4b set with card numbers. The aggregate-UX gap is filled by
   a deterministic caption generated server-side from the result shape
   (row count, or the single value when the result is one cell).

   Corollary: one API call per ask, which also halves cost.

   [FUTURE — v2]: summarization requires an explicit BAA/egress review
   before it ships. If it comes, its starting shape is the
   aggregates-only rule: prose for results with no per-person
   identifiers, plain tables for anything row-level per client.

5. **Permission: a new `ask.query` key**, granted to super_admin and
   admin. Rejected reusing `analytics.view.org` — this path reads across
   the whole allowlist, not just analytics, so it needs to be grantable
   and revocable on its own.

6. **Hybrid execution.** Preset questions run known-good hardcoded SQL:
   instant, zero tokens, zero wrongness risk. Only free text goes
   through the model. The LLM is the fallback for the long tail, not the
   engine for the common case.

7. **Conversational follow-up — context is questions and SQL, never rows.**
   Asks in one thread resolve against each other: "How many gift cards were
   used in the last 2 months?" then "and who used it?" works. Shipped
   2026-09-05, after the gap was hit on the second real question of the
   first real session.

   **What travels.** The prior questions and the SQL that answered them.
   Never result rows, values, or captions. So the categorical claim from
   decision 4 survives intact, and follow-up needed no BAA/egress review —
   unlike answer-summarization, which still does. The prompt is explicit
   that the model is shown no results and must recompute rather than guess
   at a value it cannot see.

   **Where it comes from.** The SERVER reconstructs context from
   `ask_queries`; the client sends only a `thread_id`. Client-supplied
   history would be forgeable, and reading it back here makes the log
   load-bearing instead of write-only — the record of what was asked is now
   the record of what a refinement was refining.

   **Scoping is an enforced predicate, not an ordering.**
   `where thread_id = $1 and staff_id = $2 and organization_id = $3`. This
   query runs on the service role, because `ask_queries` is deliberately
   outside `ask_readonly`'s grants — so RLS is *not* filtering here and the
   `where` has to. `npm run verify:ask` checks both directions: the owner
   gets their thread, and another staff member with the same thread id gets
   zero rows. Asserting only the second would pass if the query were simply
   broken.

   **Where it goes in the request.** The `messages` array, after the cached
   system block — never inside `system`. Folding context into the system
   prompt is the natural-feeling wrong move: it changes the cached prefix on
   every follow-up and silently costs ~4.6x. Measured on the shipped path, a
   context-carrying follow-up still reads 3407 cached tokens: $0.0093 vs
   $0.0259 cold. Context itself cost ~111 uncached tokens (~$0.0006).

   **Depth: 3 exchanges**, bounded by the dock's "New thread" control, which
   stops being cosmetic and starts meaning something. Failed asks and
   declines are excluded — replaying broken SQL invites the model to copy
   the mistake — as are presets whose label cannot be resolved, since a bare
   id tells the model nothing a human said. Presets otherwise participate,
   using their human label as the question text.

   [AS-BUILT] The audit worry turned out narrower than the deferral
   supposed. `generated_sql` on each row stays self-contained, so an ANSWER
   is always auditable alone; only the question TEXT needs its predecessors,
   and `thread_id` makes those reachable.

## Shape

```
⌘I → AskModal → useAsk() CustomEvent → AskPanel → POST /api/ask
                                                      ├─ preset → PRESET_SQL
                                                      └─ free   → Anthropic → SQL
                                                            ↓
                                        ask_readonly connection (session_user)
                                          begin read only
                                          set request.jwt.claims = {sub: admin}
                                          select * from (<sql>) limit N
                                                            ↓
                                                      ask_queries log
```

- **`ask_readonly`** — LOGIN role, NOINHERIT, no memberships, so there is
  nothing to SET ROLE to. SELECT on the allowlist; nothing else.
  `default_transaction_read_only`, `statement_timeout`, and
  `idle_in_transaction_session_timeout` are role-level, applied at login
  whether or not the route asks for them.
- **The connection** (`server/utils/askConnection.ts`) — a pooled
  connection sized under the role's connection limit. Statement-shape
  checks (single statement, SELECT/WITH prefix) and the row-cap wrapper
  live here as *error quality*, explicitly not as security: they turn a
  malformed generation into a clear message. The role is the security.
- **`ask_queries`** — append-only log of every ask: question, the exact
  SQL that ran, row count, duration, error. Written by the route with
  the service role; a log the asker could forge is not evidence.
- **RLS still applies.** `request.jwt.claims` is session state rather
  than role state, so injecting it makes `auth.uid()` →
  `current_staff_id()` → `current_org_id()` resolve and every existing
  policy scopes results to the asking admin.

  [AS-BUILT] This was the correctness bug in the pre-design sketch: had
  execution run as a role without those claims in scope, `auth.uid()`
  would be NULL, every org-scoped policy would evaluate false, and every
  query would have returned zero rows.

## Safety rules and their enforcer

| Rule | Enforced by |
| --- | --- |
| Generated SQL never runs as a privileged role | the connection's session_user IS ask_readonly |
| No role to escalate to | ask_readonly is NOINHERIT with no memberships |
| Only SELECT, only allowlisted tables | `ask_readonly` grants |
| No writes, whatever the SQL says | role-level `default_transaction_read_only` + explicit `begin read only` |
| No runaway scan | role-level `statement_timeout = '10s'` |
| Results scoped to the asker's org and permissions | existing RLS policies |
| Only admins can ask | `ask.query`, asserted in the route |
| Result rows never reach a third party | no post-execution model call exists |
| Every ask is reconstructable | `ask_queries` |

## Flows

- **Preset** — id → `PRESET_SQL` → ask_readonly connection → table. No
  model, no tokens.
- **Free text** — question + `ASK_SYSTEM_PROMPT` (schema digest + the
  money rules) → one `claude-opus-5` call with a forced `answer_with_sql`
  tool → SQL or an explicit "cannot answer from these tables" →
  ask_readonly connection → table. The system prompt is cached (`cache_control: ephemeral`); it is
  identical on every ask.
- **Transparency** — generated SQL is returned to the client and shown
  behind a "show the query" affordance. Presets skip it: they are human
  written and reviewed, so there is nothing for the admin to audit.

## Rendering contract

How a result column is displayed is decided by its NAME, and that name is
agreed across three layers that never speak to each other at runtime:

| Layer | Owns | Where |
| --- | --- | --- |
| The prompt | **names** the column | `ASK_SYSTEM_PROMPT` (server/utils/askSchema.ts) |
| The coercion layer | **types** the value | `coerceInt8Rows` in server/utils/askConnection.ts |
| The renderer | **formats** it | app/utils/askFormat.ts, used by AskPanel |

The suffix is the whole interface. The renderer cannot inspect meaning —
it sees `spend_cents` and a value, nothing more — so the convention is
load-bearing rather than cosmetic:

| Suffix | Renders as | Status |
| --- | --- | --- |
| `_cents` | currency (`35641` -> `$356.41`) | **IMPLEMENTED** |
| `_at` | a formatted date/time | **STOPGAP NOW, full rendering next** |
| `_id` | a link on the record's name, to that record's page | **IMPLEMENTED** |

`_at` and `_id` were deferred until the dock shipped and made the gap
concrete: because the prompt asks for these columns on *every* query, the
model now returns them constantly, so the contract's unfinished half is
the dock's missing half. They are no longer a later phase — they are the
immediate next task.

### Implemented (`_cents`)

`_cents` -> currency, end to end. `sum(x_cents)` is widened to int8 by
Postgres and handed back as a *string* by node-postgres;
`coerceInt8Rows` types int8 columns to numbers so the route's JSON
contract can promise that a numeric column arrives as a number.
`currencyColumns` then classifies a `_cents` column as money only when
every value in it is numeric, and `formatCell` divides by 100 at the
display edge — never in SQL, which would put floats into money math.

`numeric` (OID 1700) is deliberately NOT coerced: it can carry real
decimals and magnitudes past 2^53, so it stays a string and the
renderer's string path handles it. Same for any int8 beyond
`MAX_SAFE_INTEGER` — a raw digit string beats a quietly wrong total.

### Stopgap, and what full rendering means (`_at` and `_id`)

Shipped as holding measures so nothing raw reaches the screen:

- **`_at` → a basic date.** `Aug 23, 2026, 3:58 PM`, or `Aug 23, 2026`
  for a `::date` cast. Day-only values are formatted in **UTC** on
  purpose: a `::date` arrives as midnight UTC, and formatting that in a
  western local zone shows the *previous day*. Full rendering should use
  the LOCATION's timezone — the same basis availability already uses —
  rather than the browser's.
- **`_id` → hidden.** ~~Stopgap.~~ **Now implemented** — see below. The
  column is still never displayed; it is now *consumed* to build a link.

Full rendering, next:

- **`_at`**: location-timezone formatting, and relative phrasing where it
  helps ("3 days ago") for recency questions.
- **`_id`**: **DONE.** The name cell links through to the record —
  `client_id` → `/clients/[id]`, `staff_id` → `/staff/[id]`. This is the
  clickable-to-profile capability from the reference findings (item 4
  below), arriving through the column convention rather than through
  markdown links, and it needed no schema, prompt, or route change.

  **Pairing rule:** an entity id owns the run of plain text columns that
  immediately FOLLOWS it, ending at the first column that is not a text
  label. `client_id, first_name, last_name, spend_cents` links both name
  cells to that client and stops at the money column. Two entities in one
  row stay apart, because each id starts a new run.

  **Routes are an allowlist**, not derived from the column name. An id
  with no page of its own (`appointment_id`, `service_id`) is still
  hidden, just not linked — inferring `/appointments/[id]` from the
  suffix would manufacture confident 404s. A null id (an unmatched outer
  join) yields no link rather than a route ending in "null".

  Not shipped from the reference version: the initials avatar. The link
  is text only for now, which suits a table cell better than a chip does.

  The dock deliberately stays OPEN when a link is followed — the answer
  is meant to sit still while the admin acts on it, which is the whole
  reason it is a dock and not a page.

Both live in `app/utils/askFormat.ts`, where the rules are unit-tested.

Worth being explicit, because it looked like a separate feature: the
**entity-chip rendering** admired in the reference implementation (item 4
below — assistant output rendered through a component map, links to
entity routes becoming inline chips) is not a separate design. It IS the
`_id` rule. Their model emits markdown links and the renderer decorates
them; ours emits `client_id` alongside the name and the renderer links
the row to `/clients/[id]`. Same idea, arriving through the column
convention rather than through markdown — which is why the prompt now
asks for the id to be selected alongside the label.

### The soft-guarantee gap

Presets are safe by construction: their SQL is human-written and
reviewed, so the suffixes are correct by inspection. **The free-text path
is not.** It depends on the model following the naming convention, and no
amount of server-side code can make that a hard guarantee — the model
chooses the aliases.

Two things narrow the gap as far as it can be narrowed:

1. **The prompt states the convention emphatically**, as an output
   contract rather than a style note, with all three suffixes named and
   the failure mode spelled out ("a wrong number that looks like a right
   one"). That is what makes a soft guarantee as strong as a soft
   guarantee gets.
2. **`columnLabel` honesty is the backstop.** A `_cents` column is
   treated as money only if every value in it is numeric; otherwise the
   suffix stays in the header. So a miss renders as
   **"Spend cents: 35641"** — ugly, obviously unformatted, and correct
   about its units — instead of **"Spend: 35641"**, which is a wrong
   number wearing a right label. The design goal is not to prevent every
   miss but to guarantee a miss LOOKS like one.

A residual case remains and is accepted: if the model aliases a money
column without any `_cents` suffix (`total_revenue`), the renderer has
nothing to key on and shows a bare integer of cents. The "show the query"
affordance is the admin's recourse — the SQL is right there, and
`ask_queries` keeps it for review afterwards.

## Deferred

- ~~Conversation history in the panel (v1 is a single exchange).~~
  **Superseded.** The dock now keeps a VISUAL history: asks stack as Q&A
  pairs, newest at the bottom, with a "new thread" control to clear them.
  Each entry keeps its own column plan and its own "show SQL", and
  entries resolve independently — a slow question does not block a later
  quick one.

  This is deliberately NOT conversational refinement. `/api/ask` still
  receives one question and no prior turns, so "and how about last
  month?" does not resolve against the question above it. That remains
  open — see below.
- Rate limiting and per-question cost caps — `ask_queries` now carries
  the data to size them, which is the right order.
- Write-shaped abilities ("draft a winback email"). Read-only in v1;
  actions stay human-initiated.
- Screen-deep suggestions that interpolate the entity on detail pages —
  presets are route-keyed today, not entity-aware.
- Regenerating the schema digest from live `comment on` metadata instead
  of the hand-written constant in `server/utils/askSchema.ts`.
- Entity-chip rendering of result rows into clickable links.

## Verification (2026-08-30, against the hosted database)

Reproducible, and kept in the repo rather than thrown away:

    npm run verify:ask       # scripts/verify-ask.mjs      — the boundary
    npm run verify:presets   # scripts/verify-presets.mjs  — RLS scoping + every preset

Both run read-only on an `ask_readonly` connection built from
ASK_DATABASE_URL, and print PASS/FAIL only — never the DSN, a password,
or row contents. `verify-ask.mjs` reports ERROR rather than PASS when it
cannot connect: an earlier version counted connection failures as
refusals and produced a full table of meaningless passes, which is its
own small lesson about trusting a green result.

**The boundary — 15/15.** `session_user` and `current_user` are both
`ask_readonly`; `default_transaction_read_only=on`; `statement_timeout=10s`.

The escalation that broke the first design is refused by Postgres itself:

    set_config('role','service_role',true)  ->  permission denied to set role "service_role"
    set role service_role                   ->  permission denied to set role "service_role"
    set role postgres                       ->  permission denied to set role "postgres"

Refused by table grants: `client_notes` (the PHI exclusion, confirmed
enforced rather than merely intended), `messages`, `staff_invites`,
`audit_log`, `ask_queries`, `client_payment_methods`, and schema `auth`.
Writes refused by the read-only transaction.

**RLS scoping resolves, not just denies.** Denial without claims proves
little; the pre-design sketch would also have shown it while being
completely broken. Counting `clients` across claim states:

| Claims state | Rows visible |
| --- | --- |
| Privileged connection (ground truth) | 31 |
| No claims | 0 |
| Bogus `sub` | 0 |
| Real `ask.query` holder's `sub` | 31 |

Identity, not just table grants, is doing the scoping.

**All 15 PRESET_SQL queries execute** against the real schema. Four
return zero rows because that data does not exist yet
(`schedule.today`, `schedule.no_shows_30`, `staff.pending_time_off`,
`financials.gift_cards_outstanding`); all returned correct column counts.

**End-to-end through /api/ask** (`node scripts/e2e-ask.mjs`, against the
running app with real minted sessions):

| Step | Result |
| --- | --- |
| unauthenticated | 401 Not signed in |
| signed in, no `ask.query` | 403 Missing permission: ask.query |
| preset `clients.new_this_month` | 200, 31 rows, caption "31 rows.", `sql: null` |
| free text "How many clients do we have in total?" | 200, model wrote a `count(*) FILTER` query, 1 row, ~4s |
| unanswerable health-notes question | 200, `sql: null`, declined with a reason instead of inventing a table |
| `ask_queries` | one row per ask, with SQL, row count, duration; declines logged with their reason |

[AS-BUILT] The first end-to-end run returned **zero rows for a preset that
returns 31**, and the failure mode is the one worth remembering:
`serverSupabaseUser()` in this version of @nuxtjs/supabase returns decoded
JWT claims, where the user id is `sub` — not a `User` object with `.id`.
The module *types* it as `User`, so `user.id` typechecked while being
`undefined` at runtime. `JSON.stringify` then dropped the key, the claims
went out with no `sub`, `auth.uid()` was null, and RLS correctly denied
everything. The route answered "No rows matched that question."

Nothing errored. A silent wrong answer that reads as a real answer is the
worst failure this feature can produce, so `executeAskQuery` now refuses
to run without a caller identity rather than letting an empty identity
degrade into an empty result. The route accepts either `sub` or `id` so a
library change cannot reintroduce it.

Note for elsewhere in the codebase: the same `user.id` assumption appears
in `server/api/clients/[id]/health-notes.get.ts`,
`server/api/appointments/index.post.ts`, and `server/api/checkout/index.post.ts`,
which write `actor_user_id` into `audit_log`. Confirmed against live data —
`health_note.viewed` (40 rows), `appointment.booked` (6), `pos.checkout`
(5) all have `actor_user_id` null. `actor_staff_id` is populated in every
case, so the audit trail still identifies the actor; the redundant second
identifier is the part that is missing. Not fixed here — out of scope for
this phase.

## Review log

- **2026-08-30 — execution model bounced and re-adjudicated, after the
  broken version had already been applied.** The migration shipped for
  review with a `SET LOCAL ROLE` construction, was pushed to the hosted
  database before the review landed, and was then rejected: under PostgREST, `set_config('role','service_role',true)`
  inside a single generated SELECT escalates past every layer, because
  role-change privilege is checked against the session user
  (`authenticator`) and that role is a member of `service_role`. Reverted
  to the originally adjudicated option — a dedicated LOGIN connection.

  Worth recording as a specimen rather than a mishap. The rejected
  migration was articulate, thoroughly commented, internally consistent,
  and wrong about exactly one word — *session*. Everything downstream of
  that word followed correctly from it, which is what made it read as
  sound. This is the same class of catch as the refund route's
  constraint: the kind of error that only surfaces when a second reader
  checks the premise rather than the reasoning. The review process
  working as designed.

  Standing rule extracted: **execution runs on a session whose
  session_user is the leash — never role-switching within a privileged
  session.**

  Because `20260830175615` was already applied, it was restored to its
  as-deployed text rather than edited, and the fix ships forward in
  `20260830181826_ask_readonly_login_role.sql` — which drops
  `ask_execute_sql`, revokes the `authenticated` membership, and converts
  the role to LOGIN. Two process notes for next time: the migration was
  pushed while still under review, and the reviewer's file was
  subsequently edited in place before anyone checked whether it had been
  applied. Either alone would have been recoverable; together they
  briefly left the file and the database describing different systems.

## Reference implementation findings (reviewed 2026-08-30)

Source: sonnysangha/CRM-Recruitment-app… — components/agent/ (AgentDock,
AgentPanel, ask-vetra-modal) + app/api/agent/route.ts. Read in full.

**The plot twist: it is NOT text-to-SQL.** Vetra is a tool-calling agent —
the route hands Claude (AI SDK streamText, up to 20 steps) a toolbox:
Sanity MCP query tools (GROQ), ACTION tools that create/move/archive
records, and client-side tools (navigate_to, get_current_page). The model
chooses tools and loops. More powerful and more dangerous than our v1:
his agent can WRITE. His safety story is good — action tools wrap the
same server actions the UI calls, inheriting the same enforcement path —
and that pattern is our V2 if "do something" asks ever come. Our v1 stays
read-only text-to-SQL through the SELECT-only role.

**Steal wholesale (the UX layer):**

1. **The ask() event dispatcher** — a tiny askVetra(text) that fires a
   window CustomEvent; the dock listens. The ⌘I modal uses it, but so do
   AskChip/AskButton components scattered across pages — the whole app
   becomes ask-aware for pennies. Vue port: a useAsk() composable
   wrapping the same CustomEvent (or mitt).
   [AS-BUILT] Ported as `useAsk()`; `askText()` is the one-liner any
   component can call. No AskChip components placed yet.
2. **Screen-deep suggestions** — not just route-keyed: on detail pages it
   reads the entity name (his: polling main h1; ours: page state, cleaner)
   and interpolates it. /clients/[id] → "When did Samuel Adeyemi last
   visit?" List pages get portfolio questions; unknown routes get org-wide
   defaults. Also: separate "Do something" action chips are rendered
   distinctly from question suggestions — a good visual grammar even
   though our v1 has no actions.
   [AS-BUILT] Route-keyed only in phase 1; entity interpolation deferred.
3. **Tool receipts** — collapsible rows per tool call: friendly label
   ("Searching your records"), spinner → check → error states, <details>
   expanding to the raw query. This IS our show-SQL affordance, already
   UX-solved. Friendly-label map + truncated query hint in mono.
   [AS-BUILT] Collapsed to a single "show the query" disclosure, since
   v1 has exactly one step to report rather than a tool loop.
4. **Entity-chip markdown rendering** — assistant answers render through
   a custom markdown component map; links matching entity routes become
   inline chips (initials avatar + name, clickable). The LLM just writes
   markdown links to /clients/[id]; the renderer does the magic. GFM
   tables get the design system's table styling the same way.
   [AS-BUILT] Not applicable in v1 as described — there is no
   model-written prose to render. The capability is not dropped, though:
   it reappears as the `_id` rule in the Rendering contract above, where
   the chip is driven by a column suffix instead of by markdown links.
5. **The small stuff, all worth keeping**: post-answer "Next" suggestion
   chips, empty-state "the screen you're on" entity card, copy-as-plain-
   text (markdown stripped, for pasting into email), stop button during
   streaming, new-thread button, plan-gating on the dock (his Clerk
   feature flag ↔ our permission key), typewriter placeholder cycling
   example questions in the ⌘I modal.
   [AS-BUILT] Shipped: typewriter placeholder, permission gating,
   copy-as-plain-text (caption + TSV). Deferred: next-suggestion chips,
   empty-state entity card, stop button (v1 does not stream).

**Deliberate differences (recorded intent):**

- Query path: his = MCP/GROQ against Sanity, org-scoped via URL filter;
  ours = SQL against Postgres through the dedicated SELECT-only role —
  a stronger boundary, same receipts UI on top.
- Stack: React/Next + AI SDK useChat streaming. Components don't port to
  Vue/Nuxt but every decision does; use an established streaming-chat
  pattern rather than hand-rolling SSE.
- His hybrid is all-LLM; ours keeps preset questions on known-good
  hardcoded SQL (instant, free) with the LLM only for free text.

## Still open

- Rate limiting and cost caps — deferred, not decided.
- A scoped-down provider version answering only own-book questions.
  v1 is admins only.
- Whether preset SQL should live in the database (as views) rather than
  in `server/utils/askPresets.ts`, so the ask role's grants alone define
  what a preset can touch.
