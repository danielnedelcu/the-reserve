// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildContextMessages,
  CONTEXT_DEPTH,
  type PriorTurn,
} from "../../server/utils/askContext";

/**
 * Follow-up context: what may be replayed to the model, and what may not.
 *
 * The invariant these protect is the categorical one — questions and SQL
 * travel, result rows never do. A test that only checked "context is built"
 * would pass while leaking values, so several of these assert on ABSENCE.
 */

const turn = (over: Partial<PriorTurn> = {}): PriorTurn => ({
  question: "How many gift cards were used in the last 2 months?",
  presetId: null,
  generatedSql: "select count(*) from payments where method = 'gift_card'",
  error: null,
  ...over,
});

describe("buildContextMessages", () => {
  it("replays a prior question and its SQL as a user/assistant pair", () => {
    const messages = buildContextMessages([turn()]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("How many gift cards were used");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toContain("select count(*)");
  });

  it("returns nothing for a brand-new thread — not an error", () => {
    // The first question of a thread has no predecessors and is answered
    // standalone. Empty is the normal case, not a failure.
    expect(buildContextMessages([])).toEqual([]);
  });

  it("drops asks that failed", () => {
    // Replaying broken SQL invites the model to copy the mistake into the
    // refinement, so a failed generation is noise rather than context.
    const messages = buildContextMessages([
      turn({ error: "syntax error at or near \"slect\"", generatedSql: "slect 1" }),
    ]);
    expect(messages).toEqual([]);
  });

  it("drops declines, which are stored as errors", () => {
    const messages = buildContextMessages([
      turn({ generatedSql: null, error: "There is no health-notes table." }),
    ]);
    expect(messages).toEqual([]);
  });

  it("drops turns that never produced SQL", () => {
    expect(buildContextMessages([turn({ generatedSql: null })])).toEqual([]);
  });

  it("keeps the good turns either side of a failed one", () => {
    const messages = buildContextMessages([
      turn({ question: "first" }),
      turn({ question: "broke", error: "boom" }),
      turn({ question: "third" }),
    ]);
    expect(messages.map((m) => m.content).join(" ")).toContain("first");
    expect(messages.map((m) => m.content).join(" ")).toContain("third");
    expect(messages.map((m) => m.content).join(" ")).not.toContain("broke");
  });

  it("uses a preset's human label, never its bare id", () => {
    // ask_queries stores question = null for presets; "clients.lapsed_90"
    // would tell the model nothing a human actually said.
    const messages = buildContextMessages([
      turn({ question: null, presetId: "clients.lapsed_90" }),
    ]);
    expect(messages[0]!.content).toContain("Who hasn't visited in 90 days?");
    expect(messages[0]!.content).not.toContain("clients.lapsed_90");
  });

  it("drops a preset whose label cannot be resolved", () => {
    const messages = buildContextMessages([
      turn({ question: null, presetId: "some.retired.preset" }),
    ]);
    expect(messages).toEqual([]);
  });

  it("carries no result values — only the question and the SQL", () => {
    // The load-bearing assertion. If a future change starts folding
    // captions or rows into context, this fails.
    const messages = buildContextMessages([
      turn({ question: "How many clients?", generatedSql: "select count(*) from clients" }),
    ]);
    const blob = JSON.stringify(messages);
    expect(blob).not.toContain("Samuel");
    expect(blob).not.toContain("29");
    expect(blob).not.toContain("Client count");
    expect(blob).toContain("select count(*) from clients");
  });

  it("keeps the depth constant at the documented 3", () => {
    expect(CONTEXT_DEPTH).toBe(3);
  });
});
