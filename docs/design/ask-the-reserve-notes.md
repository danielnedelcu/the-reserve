# "Ask The Reserve" — AI query layer (pre-design notes)

Status: pre-design capture (2026-08-30). No build scheduled — sequenced
after memberships (§3); the pgvector half additionally waits on intake
forms (§6) producing a corpus. Start the eventual design session here.

## The vision (as raised)

Super admins and admins ask questions in plain English — including fuzzy,
semantic ones — and get meaningful answers from the business's data,
through an in-app UI.

## The reframe that shapes the whole design

The feature is TWO different capabilities wearing one UI, and they need
different tools:

**1. Questions about structured data → text-to-SQL, not vectors.**
"Which clients haven't visited in 90 days?" / "Top spenders this quarter?"
/ "Gift cards sold but never redeemed?" / "Members approaching lapse?" —
these are aggregates, filters, and date math. Vector similarity cannot
count, sum, or compare dates; SQL is the right and only tool. An LLM
translates the question into SQL against our schema and the result comes
back as data (optionally LLM-summarized).

Why The Reserve is unusually well-positioned: text-to-SQL quality tracks
how well the schema explains itself, and this schema is fully commented
IN the database (comment on table/column), exported to docs/schema/ by
tbls, with business rules recorded in docs/design/ ("gift cards are
liabilities, excluded from revenue"). The documentation discipline is the
feature's foundation.

**2. Questions about unstructured text → pgvector + embeddings.**
"Clients who mentioned shoulder tension" / "who noted scent
sensitivities" — meaning-based retrieval over free text that SQL cannot
express. This half is REAL but currently starved: today's corpus is short
client notes and little else. It becomes worth building when intake forms
(§6) ship — waivers, health histories, free-text preferences — and notes
accumulate. Staff messages are EXCLUDED from any corpus (private comms).

## Architecture sketches (for the design session, not commitments)

### Text-to-SQL assistant

- Server route, permission-gated (analytics.view.org, or mint ask.\* keys).
- Prompt = question + schema documentation (docs/schema/ content or the
  live comments) + the business-rule cheat sheet (revenue exclusions,
  liability semantics, appointment status meanings).
- SAFETY BOUNDARY (non-negotiable): generated SQL never runs as service
  role. Execute through a dedicated Postgres role with SELECT-only grants
  on an approved table list (no auth.\*, no staff_invites, no messages),
  statement_timeout set, and the SQL logged with the question in an
  audit-style table. Read-only role + allowlist is the design; prompt
  hardening is defense-in-depth on top, never the boundary itself.
- Results rendered as a table in the UI; optional LLM summarization pass.
- Show the SQL to the admin (transparency doubles as trust + debuggability).
- Engine: Anthropic API (already integrated conceptually via 4b-era
  patterns; key handling follows the env/runtimeConfig boundary rules).

### Semantic notes search (post-intake-forms)

- `create extension if not exists vector;` via migration (house rules —
  it's schema).
- embeddings table: id, organization_id (+ RLS), source_type
  ('client_note','intake_response'), source_id, client_id, content_hash,
  embedding vector(1536), created_at. HNSW index.
- Embedding happens in a SERVER ROUTE on write (triggers cannot make
  external calls — see .claude skill, constraints-and-triggers.md), or a
  small queue/backfill job. Re-embed on edit via content_hash comparison.
- match RPC (p\_ prefixed) doing cosine similarity, org-scoped, LIMIT n.
- PRIVACY GATES, designed in from day one:
  - Health-note embeddings are PHI leaving the database to an embedding
    API — provider choice is a compliance question (BAA availability),
    not just pricing. Option: exclude kind='health' from embedding
    entirely in v1.
  - The embeddings table inherits client_notes' sensitivity tiering:
    search results must respect clients.notes.health.view, enforced in
    the RPC/RLS, not the UI.
  - Messages never embed.

## What pairs with what (the tooling map)

- pgvector: storage + similarity search only. Produces nothing.
- Embedding model (OpenAI text-embedding-3-small, Voyage, etc.): text →
  vector, called at write time and query time. Cheap, not an LLM.
- LLM (Anthropic API): two jobs — SQL generation (capability 1) and
  answer synthesis over retrieved rows (RAG, capability 2). Only needed
  at the ask-a-question layer.

## Sequencing recommendation

1. NOW: this capture. Nothing built.
2. AFTER MEMBERSHIPS: text-to-SQL assistant as its own small phase —
   modest lift, high value, and every subsequent phase (memberships,
   intake, cancellation) makes it more useful for free since it reads
   whatever the schema holds.
3. AFTER INTAKE FORMS: enable pgvector, build the embeddings pipeline for
   notes + intake responses; fold semantic retrieval into the same ask UI.

## Open questions for the eventual design session

- Who can ask? (admins only, or a scoped-down provider version answering
  only own-book questions?)
- Query cost controls: per-question LLM spend is real money — rate limit?
  cache repeated questions?
- Where does the UI live? (A page? The command palette grows an "ask"
  mode? The palette is the natural home for v1.)
- Does the assistant get WRITE-shaped abilities ever ("draft a winback
  email to lapsed members")? Recommendation: no in v1 — read-only answers;
  actions remain human-initiated.
- Embedding provider + BAA question if health text is ever in scope.
