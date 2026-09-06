# "Ask The Reserve" — AI query layer (pre-design notes)

Status: pre-design capture (2026-08-30); UI flow added same day.
RESEQUENCED: the text-to-SQL half is pulled AHEAD of memberships (§3 is
owner-blocked; this is unblocked). The pgvector half still waits on
intake forms (§6) producing a corpus. Start the design session here.

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
  ('client_note','intake_response','ask_question'), source_id, client_id,
  content_hash, embedding vector(1536), created_at. HNSW index.
  [ADDED 2026-09-05] `ask_queries.question` is a third corpus, and a
  cheap one: it is already org-scoped, carries no PHI, and needs no new
  privacy design. Its use is different from the other two — not answering
  questions from notes, but choosing WHICH prior turns to carry as
  follow-up context, replacing "the last 3" with "the most related". See
  the context-scaling note in ask-the-reserve-design.md. Free to add once
  the pipeline exists; not a reason to build the pipeline.
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

## Sequencing recommendation (revised 2026-08-30)

1. NOW: text-to-SQL assistant as the next build phase — memberships is
   owner-blocked, this is unblocked, and every later phase (memberships,
   intake, cancellation) makes it more useful for free since it reads
   whatever the schema holds. Design session first, same as every phase.
2. AFTER INTAKE FORMS: enable pgvector, build the embeddings pipeline for
   notes + intake responses; fold semantic retrieval into the same ask UI.

## UI flow (decided 2026-08-30, adapted from a reference React project)

Two keyboard surfaces with two contracts — do NOT merge into the palette:

- **⌘K stays what it is**: deterministic, instant, navigational.
- **⌘I opens the ask modal**: generative, seconds-latency, informational.

The flow: **⌘I → prompt modal → results panel.**

1. **Prompt modal**, context-aware: shows ~3 preset questions keyed to
   the current route (/clients → "Who hasn't visited in 90 days?",
   "Top spenders this quarter", "New clients this month"; /financials →
   its own trio; etc.) plus a free-text input. Presets live in a
   route-keyed config — plain data, easy to grow.
2. **Hybrid execution** (the key architecture decision): presets run
   KNOWN-GOOD hardcoded SQL — instant, zero tokens, zero wrongness risk.
   Only the free-text input goes through the LLM → SQL path. The LLM is
   the fallback for the long tail, not the engine for the common case.
3. **Results panel**, bottom-right chat-style: doesn't navigate away,
   persists while the admin acts on the answer. Renderer handles tables,
   paragraphs, and lists; entity rows are clickable to their pages
   (client_id → /clients/[id] — the consistent-ID discipline pays off).
   Every LLM-generated result carries a collapsible "show SQL"
   affordance (transparency = trust + debuggability); preset results
   may skip it.

Reference implementation exists (a React project with this exact flow);
review its code before building for: where SQL executes and as what
role (our SELECT-only-role boundary is non-negotiable regardless),
retry/error handling for bad LLM SQL, streaming vs blocking results,
and whether the panel holds history.

## Open questions for the eventual design session

- Who can ask? (admins only, or a scoped-down provider version answering
  only own-book questions?)
- Query cost controls: per-question LLM spend is real money — rate limit?
  cache repeated questions?
- Chat panel: does it hold conversation history across questions
  (follow-up refinement) or reset per ask? (v1 lean: reset, single
  exchange; history is the v2 upgrade.)
- Does the assistant get WRITE-shaped abilities ever ("draft a winback
  email to lapsed members")? Recommendation: no in v1 — read-only answers;
  actions remain human-initiated.
- Embedding provider + BAA question if health text is ever in scope.
