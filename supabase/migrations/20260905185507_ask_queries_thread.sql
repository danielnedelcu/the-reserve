-- ============================================================
-- Migration: ask_queries — conversation threads
-- npx supabase migration new ask_queries_thread
--
-- Follow-up questions need the questions that came before them: "and who
-- used it?" is unanswerable on its own, and today the model correctly
-- says so. Threading is what lets the route hand it the prior turns.
--
-- The route reconstructs that context FROM THIS TABLE rather than
-- trusting the client to post its own history. Two reasons: client-sent
-- history would be forgeable, and reading it back here makes the audit
-- log load-bearing instead of write-only — the record of what was asked
-- becomes the record of what a refinement was refining.
--
-- Only questions and their generated SQL are ever replayed as context.
-- Result rows are not, and must never be: "client data never leaves the
-- database" stays categorical (design doc, decision 4).
-- ============================================================

alter table ask_queries add column thread_id uuid;

comment on column ask_queries.thread_id is
  'Groups the asks of one dock session, bounded by the "New thread" control. Null on rows written before threading existed, and on any ask made outside a thread. A refined question ("and who used it?") is only interpretable alongside the rows sharing its thread_id — note that generated_sql on each row stays self-contained, so an ANSWER is always auditable on its own; it is the question TEXT that needs its predecessors.';

-- Every free-text ask reads the most recent few rows of one thread, so
-- index exactly that access pattern. Partial: pre-threading rows and
-- unthreaded asks are never the target of this lookup.
create index ask_queries_thread on ask_queries (thread_id, created_at desc)
  where thread_id is not null;
