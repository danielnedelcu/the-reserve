-- ============================================================
-- Migration: ask_queries — the resolved question
-- npx supabase migration new ask_queries_resolved_question
--
-- Threading made a logged row stop standing on its own: "and who used
-- it?" cannot be interpreted without the turns above it. The model
-- already has to resolve that reference in order to write the SQL, so it
-- now returns the resolved form as well, and that is what gets logged
-- beside the words the admin actually typed.
--
-- Restores the two things threading cost: an audit row that can be read
-- alone, and the ability to mine the log for what people ask without
-- reconstructing every thread to find out what each question meant.
-- ============================================================

alter table ask_queries add column resolved_question text;

comment on column ask_queries.resolved_question is
  'The question with its references resolved against the thread — "and who used it?" recorded as "which clients redeemed gift cards in the last 2 months?". Equal to question on a first turn, where there is nothing to resolve. Null on the preset path (no model ran) and on rows written before this column existed. Read THIS when auditing an answer or mining the log; `question` keeps what was literally typed, which is what the admin will recognise.';
