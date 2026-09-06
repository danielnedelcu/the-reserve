// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseFields, validateAnswers, isEmptyAnswer } from "../../shared/forms/fields";
import { buildAnswerSchema, requiredAnswersPresent } from "../../shared/forms/validation";

/**
 * The client schema and the server validator must agree.
 *
 * This is the test that exists because of a pattern, not a hunch. Five
 * separate bugs in this feature came from two code paths deciding one
 * predicate and disagreeing only at the edges — the route and the RPC on
 * what a "prospect link" is, and most recently the public form and the
 * server on whether `false` counts as an answer. Both agreed on every
 * ordinary case and diverged exactly where it mattered.
 *
 * So the cases below are deliberately the awkward ones: false, zero-ish
 * values, whitespace, empty arrays, malformed dates. A battery of happy
 * paths would pass while the two drifted apart.
 */

const FIELDS = parseFields([
  { key: "first_name", label: "First name", type: "text", required: true, sensitive: false },
  { key: "nickname", label: "Nickname", type: "text", required: false, sensitive: false },
  { key: "email", label: "Email", type: "email", required: true, sensitive: false },
  { key: "dob", label: "Date of birth", type: "date", required: false, sensitive: false },
  { key: "agrees", label: "Do you agree?", type: "boolean", required: true, sensitive: false },
  { key: "pregnant", label: "Pregnant?", type: "boolean", required: false, sensitive: true },
  {
    key: "focus",
    label: "Focus",
    type: "multiselect",
    required: false,
    sensitive: false,
    options: ["neck", "back"],
  },
]);

const schema = buildAnswerSchema(FIELDS);

/** Does the SERVER accept these answers? */
function serverAccepts(answers: Record<string, unknown>): boolean {
  try {
    validateAnswers(FIELDS, answers);
    return true;
  } catch {
    return false;
  }
}

/** Does the CLIENT let the button light up for these answers? */
function clientAccepts(answers: Record<string, unknown>): boolean {
  // Both halves, exactly as the page uses them: the schema catches
  // malformed values, requiredAnswersPresent catches missing ones.
  return (
    schema.safeParse(answers).success && requiredAnswersPresent(FIELDS, answers)
  );
}

const base = { first_name: "Samuel", email: "s@example.test", agrees: true };

describe("client schema and server validator agree", () => {
  const cases: { name: string; answers: Record<string, unknown> }[] = [
    { name: "a complete, valid submission", answers: { ...base } },
    { name: "answering NO to a required boolean", answers: { ...base, agrees: false } },
    { name: "answering no to an optional health boolean", answers: { ...base, pregnant: false } },
    { name: "a missing required text field", answers: { email: "s@example.test", agrees: true } },
    { name: "a whitespace-only required field", answers: { ...base, first_name: "   " } },
    { name: "an empty-string optional field", answers: { ...base, nickname: "" } },
    { name: "a missing required boolean", answers: { first_name: "S", email: "s@example.test" } },
    { name: "a malformed email", answers: { ...base, email: "not-an-email" } },
    { name: "an impossible date", answers: { ...base, dob: "2026-02-31" } },
    { name: "a well-formed date", answers: { ...base, dob: "1990-05-02" } },
    { name: "an empty multiselect", answers: { ...base, focus: [] } },
    { name: "a valid multiselect", answers: { ...base, focus: ["neck"] } },
  ];

  for (const { name, answers } of cases) {
    it(`agrees on: ${name}`, () => {
      // The assertion is the AGREEMENT, not either verdict on its own.
      // If one side starts accepting what the other rejects, this fails
      // regardless of which one is "right".
      expect({ case: name, client: clientAccepts(answers) }).toEqual({
        case: name,
        client: serverAccepts(answers),
      });
    });
  }
});

describe("isEmptyAnswer — the definition both sides share", () => {
  it("treats false as an ANSWER, never as empty", () => {
    // The exact bug: the public form dropped false before sending, so an
    // explicit "no" vanished and a required yes/no could not be satisfied.
    expect(isEmptyAnswer(false)).toBe(false);
    expect(isEmptyAnswer(true)).toBe(false);
  });

  it("treats absence, blank strings and empty lists as empty", () => {
    expect(isEmptyAnswer(undefined)).toBe(true);
    expect(isEmptyAnswer(null)).toBe(true);
    expect(isEmptyAnswer("")).toBe(true);
    expect(isEmptyAnswer("   ")).toBe(true);
    expect(isEmptyAnswer([])).toBe(true);
  });
});

describe("requiredAnswersPresent", () => {
  it("is satisfied by a required boolean answered NO", () => {
    expect(requiredAnswersPresent(FIELDS, { ...base, agrees: false })).toBe(true);
  });

  it("is not satisfied while a required field is untouched", () => {
    expect(requiredAnswersPresent(FIELDS, { first_name: "S", agrees: true })).toBe(false);
  });
});
