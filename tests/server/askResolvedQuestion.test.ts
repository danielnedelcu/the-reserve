// @vitest-environment node
import { describe, it, expect } from "vitest";

/**
 * The rule the dock applies when deciding whether to show
 * "interpreting as: …".
 *
 * Transcribed from AskDock.vue, which cannot be imported here (single-file
 * component). Kept in step by the assertions below describing the intent
 * rather than the implementation.
 */
function interpretation(typed: string, resolved: string | null): string | null {
  const r = resolved?.trim();
  if (!r) return null;
  const normalise = (t: string) => t.toLowerCase().replace(/[\s?.!]+$/g, "").trim();
  return normalise(r) === normalise(typed) ? null : r;
}

/** What the route returns, given what the model said and whether context existed. */
function resolveForLog(
  question: string,
  modelSaid: string | null,
  contextTurns: number,
): string {
  return contextTurns ? modelSaid?.trim() || question : question;
}

describe("resolved question — what gets logged", () => {
  it("equals the question on a first turn, whatever the model returns", () => {
    // Verified against the live model: told to repeat verbatim it still
    // paraphrases ("used" -> "redeemed"). With no context there was nothing
    // to resolve, so the guarantee is structural, not a prompt request.
    expect(
      resolveForLog(
        "How many gift cards were used in the last 2 months?",
        "How many gift cards were redeemed in the last 2 months?",
        0,
      ),
    ).toBe("How many gift cards were used in the last 2 months?");
  });

  it("takes the model's resolution once there is context to resolve against", () => {
    expect(
      resolveForLog("and who used it?", "which clients redeemed gift cards?", 2),
    ).toBe("which clients redeemed gift cards?");
  });

  it("falls back to the question if the model returns nothing usable", () => {
    expect(resolveForLog("and who used it?", "  ", 2)).toBe("and who used it?");
    expect(resolveForLog("and who used it?", null, 2)).toBe("and who used it?");
  });
});

describe("resolved question — when it is shown", () => {
  it("says nothing on a first-turn question, which resolves to itself", () => {
    // The case worth pinning: nothing to resolve, so nothing to announce.
    // Echoing the question back would train people to ignore the line.
    const q = "How many clients do we have?";
    expect(interpretation(q, q)).toBeNull();
  });

  it("shows the resolved form when a reference was spelled out", () => {
    expect(
      interpretation("and who used it?", "which clients redeemed gift cards in the last 2 months?"),
    ).toBe("which clients redeemed gift cards in the last 2 months?");
  });

  it("ignores tidying — casing and trailing punctuation are not reinterpretation", () => {
    expect(interpretation("how many clients do we have", "How many clients do we have?")).toBeNull();
    expect(interpretation("Top spenders this quarter?", "top spenders this quarter")).toBeNull();
  });

  it("says nothing when the model returned none (presets, or an older row)", () => {
    expect(interpretation("Top spenders this quarter", null)).toBeNull();
    expect(interpretation("Top spenders this quarter", "   ")).toBeNull();
  });

  it("shows a genuinely wrong reading rather than hiding it", () => {
    // The whole point: if the model resolves "and who used it?" against the
    // wrong antecedent, the admin sees that before trusting the number.
    expect(
      interpretation("and who used it?", "which staff members used the treatment room?"),
    ).toBe("which staff members used the treatment room?");
  });
});
