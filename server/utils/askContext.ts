import { presetLabel } from "~~/shared/ask/presets";

/**
 * Ask The Reserve — turning logged asks into follow-up context.
 *
 * "and who used it?" is unanswerable alone. This shapes the earlier asks of
 * the same thread into the messages that precede it, so the model can
 * resolve the reference.
 *
 * WHAT TRAVELS: questions and the SQL that answered them. NEVER result
 * rows, values, or captions. That is what keeps "client data never leaves
 * the database" categorical (design doc, decision 4) and is why follow-up
 * needs no BAA/egress review, unlike answer-summarization would.
 *
 * WHERE IT GOES: the returned messages belong in the `messages` array,
 * AFTER the system block — never inside the system prompt. The system block
 * carries `cache_control` and is byte-identical on every ask; folding
 * context into it would change the cached prefix on every follow-up and
 * silently cost ~4.6x per ask (see the baseline in docs/TODO.md).
 */

/** One earlier ask, as stored in ask_queries. */
export interface PriorTurn {
  question: string | null;
  presetId: string | null;
  generatedSql: string | null;
  error: string | null;
}

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * How many earlier exchanges a follow-up carries.
 *
 * Cost stopped being the reason for a limit once the context prefix is
 * cached; relevance is. A thread that wandered from clients to products to
 * payroll hands the model twenty turns of irrelevant anchoring, and more
 * context makes answers worse, not just pricier. Twenty is a judgement
 * call, not a measurement.
 *
 * It is also the point where prefix caching stops helping: the window
 * slides once a thread passes this many turns, so every later turn shifts
 * the messages and misses the cache. Threads that long are rare; the cost
 * simply reverts to what it was before caching.
 */
export const CONTEXT_DEPTH = 20;

/**
 * Shape prior turns into alternating messages.
 *
 * Turns are dropped when they cannot usefully inform a follow-up:
 *
 * - **Failed asks** (`error` set). A generation that did not work is not
 *   context, it is noise — and replaying broken SQL invites the model to
 *   copy its mistake into the refinement. Declines ("no such table") are
 *   stored as errors too, and are equally unhelpful as precedent.
 * - **Turns with no SQL**, which is the same population plus anything that
 *   never reached execution.
 * - **Presets whose label cannot be resolved**, since the bare id
 *   ("clients.top_spenders_quarter") tells the model nothing a human said.
 *
 * An empty result is normal, not an error: the first question of a thread
 * has no predecessors and is answered standalone.
 *
 * @param turns oldest-first; caller supplies at most CONTEXT_DEPTH
 */
export function buildContextMessages(turns: PriorTurn[]): ContextMessage[] {
  const messages: ContextMessage[] = [];

  for (const turn of turns) {
    if (turn.error) continue;
    if (!turn.generatedSql) continue;

    const asked = turn.question ?? (turn.presetId ? presetLabel(turn.presetId) : null);
    if (!asked) continue;

    messages.push({
      role: "user",
      content: `Earlier in this session I asked: ${asked}`,
    });
    messages.push({
      role: "assistant",
      content: `I answered that with this query:\n${turn.generatedSql.trim()}`,
    });
  }

  return messages;
}
