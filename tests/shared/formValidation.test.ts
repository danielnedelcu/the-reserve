// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  parseFields,
  validateAnswers,
  isEmptyAnswer,
  isRealDate,
  dateKey,
  parseDateKey,
} from "../../shared/forms/fields";
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

describe("dateKey and isRealDate agree (the datepicker bridge)", () => {
  // The public form's date field is a v-calendar picker that speaks Date;
  // the contract, the schema and the server speak "YYYY-MM-DD". dateKey is
  // the only formatter between them, so every Date it can emit must be a
  // string isRealDate accepts — including the days where a UTC conversion
  // would be off by one.
  const awkward = [
    new Date(2024, 1, 29, 23, 59), // leap day, late evening
    new Date(2025, 11, 31, 23, 30), // New Year's Eve, evening
    new Date(1990, 0, 1, 0, 0), // midnight on the first
    new Date(1953, 6, 4, 12, 0), // a plausible date of birth
    new Date(2000, 2, 1, 1, 0), // the day after a non-leap Feb 28
    new Date(2026, 2, 8, 0, 30), // US DST starts this day — the 2am hour vanishes
    new Date(2026, 10, 1, 23, 30), // US DST ends this day — the 1am hour repeats
  ];

  it.each(awkward)("%s formats to a key the server accepts", (d) => {
    const key = dateKey(d);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isRealDate(key)).toBe(true);
  });

  it.each(awkward)("%s survives a round trip through parseDateKey", (d) => {
    const key = dateKey(d);
    const back = parseDateKey(key);
    expect(back).not.toBeNull();
    expect(dateKey(back!)).toBe(key);
    // and the round trip lands on the same LOCAL calendar day, not UTC's
    expect([back!.getFullYear(), back!.getMonth(), back!.getDate()]).toEqual([
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
    ]);
  });

  it("holds fourteen hours ahead of UTC, where the local day is often UTC's tomorrow", () => {
    // The suite inherits the machine's zone; this case pins one that is not
    // it. process.env.TZ takes effect for Dates created after it is set.
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      for (const d of awkward) {
        const key = dateKey(d);
        const back = parseDateKey(key);
        expect(back && dateKey(back)).toBe(key);
        expect([back!.getFullYear(), back!.getMonth(), back!.getDate()]).toEqual([
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
        ]);
      }
      // and the evening case that a UTC slice would put on tomorrow
      const evening = new Date(2026, 8, 19, 23, 30);
      expect(dateKey(evening)).toBe("2026-09-19");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("refuses what isRealDate refuses, so a bad key cannot become a Date", () => {
    for (const bad of ["2024-02-30", "1990-13-01", "not a date", "", null, undefined, 42]) {
      expect(parseDateKey(bad)).toBeNull();
    }
  });
});
