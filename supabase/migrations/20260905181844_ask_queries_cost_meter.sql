-- ============================================================
-- Migration: ask_queries — the cost meter
-- npx supabase migration new ask_queries_cost_meter
--
-- The rate-limit / cost-cap decision is deferred, and it is BLOCKED on
-- data nobody is collecting: ask_queries records duration and row count
-- but nothing about what an ask costs. Sizing a cap without that is a
-- guess, and every day without these columns is history that cannot be
-- reconstructed. So: the meter now, the limiter later.
--
-- Token counts are FACTS and are stored as such. cost_micros is a
-- SNAPSHOT taken at the rate in force when the ask ran — the same
-- discipline as name/price snapshots on transaction_items: a later price
-- change must never rewrite what a past ask actually cost.
-- ============================================================

alter table ask_queries
  add column model              text,
  add column input_tokens       int,
  add column output_tokens      int,
  add column cache_read_tokens  int,
  add column cache_write_tokens int,
  add column cost_micros        int;

comment on column ask_queries.model is
  'Which model answered, e.g. claude-opus-5. Null on the preset path — no model was called, which is the point of presets.';
comment on column ask_queries.input_tokens is
  'Uncached input tokens billed at full rate. The cached schema prompt lands in cache_read_tokens instead, so this stays small on a warm cache.';
comment on column ask_queries.cache_read_tokens is
  'Tokens served from the prompt cache (~0.1x input price). The system prompt is identical on every ask, so a healthy value here is the sign caching is working; a persistent zero means something is invalidating the prefix.';
comment on column ask_queries.cost_micros is
  'What this ask cost, in MILLIONTHS of a dollar (22500 = $0.0225). Cents would round a two-cent ask to nothing. Priced at the rate in force when it ran and never recomputed — a rate change must not rewrite history.';

-- Cost questions are always "over what period", so index the way they
-- will be asked.
create index ask_queries_org_cost on ask_queries (organization_id, created_at desc)
  where cost_micros is not null;

comment on table ask_queries is
  'Append-only record of every Ask The Reserve question: the text asked, the SQL that ran, what came back, and what it cost. No update/delete policies — a query log that can be edited is not a query log. Written by the /api/ask route; readable with ask.query. Rows with a non-null error are failed generations, which is the signal for prompt work. Rows with a null model are the preset path: answered with human-written SQL, no tokens spent.';
