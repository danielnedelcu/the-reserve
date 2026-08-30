# Design docs in docs/design/

Schema-shape work is decided in prose before it is decided in SQL. These
documents are where the *why* lives — the migration file records what was
built, `docs/schema/` (tbls-generated) records the current shape, and only
`docs/design/` records which options were considered and why one won. That
is the part nobody can reconstruct later from the database.

Write or update the relevant doc **before** drafting the SQL, not after.

## The forms these take

**`migration<N>-design.md` — decided, then built.**
`migration4a-design.md` and `migration4b-design.md` are the reference
shape:

- A `STATUS:` line at the top (`SHIPPED 2026-08-29 (mini-gauntlet verified
  in test mode)`), saying whether this is a proposal or a record.
- **Decisions locked from Q&A**, numbered, each with its reasoning and its
  bounded escape hatch — e.g. 4b's "single platform Stripe account, keys in
  env only, so a future Connect retrofit is bounded."
- **Shape** — the table relationships in a line or two of ASCII, then what
  each table is for.
- **Integrity rules**, stated as rules and attributed to their enforcer
  (trigger, constraint, or route).
- **Flows** — the routes that do the work, step by step.
- **Deferred**, explicitly, so the omissions read as choices.

Deviations discovered during the build are annotated **inline as
`[AS-BUILT]`** rather than quietly edited in. Same for forward-looking
exceptions: `[FUTURE EXCEPTION — memberships]` marks where a later phase
will legitimately break the rule being stated. The document keeps both the
decision and its history.

**`<feature>-as-built.md` — reconstructed after the fact.**
`messaging-as-built.md` covers work whose design doc wasn't preserved. It
is deliberately compact: the lasting decisions only, pointing at
`docs/schema/` for table shapes rather than duplicating them. Worth
noticing that it records the *failed* approaches too ("boring refetch chosen
over optimistic local patches after Nuxt 4's shallow `useAsyncData` ate two
clever attempts") — that is the kind of thing a future reader would
otherwise re-discover the hard way.

**`<feature>-notes.md` — pre-design.**
`memberships-notes.md` is a design session that hasn't happened yet:
the defining constraint captured, implications listed, and the open
questions that block the session. Start one of these when a feature is
looming but the decisions aren't yours to make.

**`<feature>_contract.md` — the DB/app boundary.**
`migration3_booking_contract.md` splits "what the database guarantees (you
don't have to code these)" from "what the application layer must
implement". Write one when a migration's constraints only deliver their
guarantee if routes hold up their end — the booking flow's exclusion
constraints are useless if the route doesn't handle SQLSTATE 23P01
gracefully.

**Standing status docs.**
`multi-tenancy-status.md` tracks a cross-cutting property over time, with
an inventory of known deliberate shortcuts and a dated **decision log**
("Aug 2026: Reviewed post-4a. Verdict: change nothing now."). It carries an
instruction in its own header — _"Update when tenancy-relevant decisions are
made"_ — so a migration that touches org scoping should update it rather
than leave it stale.

## Conventions across all of them

- Dates are absolute (`SHIPPED 2026-08-29`, `captured 2026-08-29`), never
  "last week".
- Cross-reference by path (`See docs/design/memberships-notes.md`) so the
  docs form a graph rather than repeating each other.
- Record the constraint that drove the design, not just the outcome — the
  Georgia tax rule in 4a, the members-only gate in the memberships notes.
  The outcome is recoverable from the schema; the constraint is not.
