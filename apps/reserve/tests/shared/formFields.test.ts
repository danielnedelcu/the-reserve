// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  parseFields,
  validateAnswers,
  assertProspectContactFields,
  contactFromAnswers,
  FormShapeError,
  type FormField,
} from "../../shared/forms/fields";

/**
 * The form engine's only un-backstopped rule.
 *
 * Postgres cannot check the shape of a jsonb column, so these functions are
 * the enforcement — the "who enforces what" table in the design doc names
 * this the row with no database backstop. Two of these tests matter more
 * than the rest: that a sensitive answer NEVER lands in the non-sensitive
 * bucket, and that an unknown key is refused rather than dropped. Both are
 * failures that would otherwise be silent.
 */

const field = (over: Partial<FormField> = {}): FormField => ({
  key: "first_name",
  label: "First name",
  type: "text",
  required: true,
  sensitive: false,
  ...over,
});

describe("parseFields", () => {
  it("accepts a well-formed field list", () => {
    const fields = parseFields([field(), field({ key: "note", required: false })]);
    expect(fields).toHaveLength(2);
    expect(fields[0]!.key).toBe("first_name");
  });

  it("refuses an empty definition", () => {
    expect(() => parseFields([])).toThrow(FormShapeError);
    expect(() => parseFields(null)).toThrow(FormShapeError);
  });

  it("refuses duplicate keys", () => {
    // Two fields sharing a key means one answer silently wins.
    expect(() => parseFields([field(), field()])).toThrow(/Duplicate field key/);
  });

  it("requires `sensitive` to be stated, never defaulted", () => {
    // A sensitive flag defaulting to false is a PHI leak written as a
    // convenience: the health split reads this flag and nothing else.
    const missing = { key: "conditions", label: "Conditions", type: "text", required: true };
    expect(() => parseFields([missing])).toThrow(/needs sensitive/);
  });

  it("requires `required` to be stated too", () => {
    const missing = { key: "note", label: "Note", type: "text", sensitive: false };
    expect(() => parseFields([missing])).toThrow(/needs required/);
  });

  it("rejects an unknown field type", () => {
    expect(() => parseFields([field({ type: "signature" as never })])).toThrow(
      /expected one of/,
    );
  });

  it("demands options for select, and forbids them elsewhere", () => {
    expect(() => parseFields([field({ type: "select" })])).toThrow(/options array/);
    expect(() =>
      parseFields([field({ type: "text", options: ["a"] })]),
    ).toThrow(/cannot carry options/);
  });

  it("rejects keys that are not stable identifiers", () => {
    expect(() => parseFields([field({ key: "First Name" })])).toThrow(/needs a key/);
    expect(() => parseFields([field({ key: "1st" })])).toThrow(/needs a key/);
  });
});

describe("validateAnswers", () => {
  const fields = parseFields([
    field(),
    field({ key: "email", label: "Email", type: "email", required: false }),
    field({
      key: "conditions",
      label: "Any conditions we should know about?",
      type: "textarea",
      required: false,
      sensitive: true,
    }),
  ]);

  it("splits sensitive answers out of the ordinary bucket", () => {
    // THE load-bearing assertion. If a future change stops honouring
    // `sensitive`, health text lands in form_responses.answers, which has
    // no health permission on it — a PHI leak with no error.
    const { answers, health } = validateAnswers(fields, {
      first_name: "Samuel",
      conditions: "shoulder injury, 2024",
    });

    expect(answers).toEqual({ first_name: "Samuel" });
    expect(JSON.stringify(answers)).not.toContain("shoulder");
    expect(health).toEqual([
      {
        fieldKey: "conditions",
        label: "Any conditions we should know about?",
        answer: "shoulder injury, 2024",
      },
    ]);
  });

  it("snapshots the question alongside a health answer", () => {
    // "yes" is meaningless without the question, and the version that
    // asked it can be superseded by a later publish.
    const yesNo = parseFields([
      field({ key: "pregnant", label: "Are you pregnant?", type: "boolean", sensitive: true }),
    ]);
    const { health } = validateAnswers(yesNo, { pregnant: true });
    expect(health[0]!.label).toBe("Are you pregnant?");
    expect(health[0]!.answer).toBe(true);
  });

  it("refuses an unknown key rather than dropping it", () => {
    // Dropping would hide both an attack and a client/server version skew.
    expect(() => validateAnswers(fields, { first_name: "S", sneaky: 1 })).toThrow(
      /Unknown field "sneaky"/,
    );
  });

  it("enforces required fields, treating blank as absent", () => {
    expect(() => validateAnswers(fields, {})).toThrow(/"First name" is required/);
    expect(() => validateAnswers(fields, { first_name: "   " })).toThrow(
      /"First name" is required/,
    );
  });

  it("omits optional unanswered fields entirely", () => {
    const { answers, health } = validateAnswers(fields, { first_name: "Samuel" });
    expect("email" in answers).toBe(false);
    expect(health).toEqual([]);
  });

  it("type-checks answers against the field type", () => {
    const typed = parseFields([
      field({ key: "dob", label: "Date of birth", type: "date" }),
      field({ key: "agree", label: "I agree", type: "boolean" }),
      field({
        key: "focus",
        label: "Focus areas",
        type: "multiselect",
        options: ["neck", "back"],
      }),
    ]);

    expect(() => validateAnswers(typed, { dob: "2026-13-01", agree: true, focus: ["neck"] }))
      .toThrow(/a real calendar date/);
    expect(() => validateAnswers(typed, { dob: "1990-05-02", agree: "yes", focus: ["neck"] }))
      .toThrow(/true or false/);
    expect(() => validateAnswers(typed, { dob: "1990-05-02", agree: true, focus: ["knee"] }))
      .toThrow(/choices from/);

    const ok = validateAnswers(typed, {
      dob: "1990-05-02",
      agree: true,
      focus: ["neck", "neck", "back"],
    });
    // Day-granular dates stay strings: turning one into a Date here would
    // reintroduce the timezone drift CLAUDE.md warns about.
    expect(ok.answers.dob).toBe("1990-05-02");
    expect(ok.answers.focus).toEqual(["neck", "back"]);
  });

  it("refuses a non-object submission", () => {
    expect(() => validateAnswers(fields, [])).toThrow(/keyed by field/);
    expect(() => validateAnswers(fields, "first_name=Samuel")).toThrow(/keyed by field/);
  });
});

describe("prospect contact rules", () => {
  const base = [
    field({ key: "first_name", label: "First name" }),
    field({ key: "last_name", label: "Last name" }),
    field({ key: "email", label: "Email", type: "email" }),
  ];

  it("accepts a form that can produce a prospect", () => {
    expect(() => assertProspectContactFields(parseFields(base))).not.toThrow();
  });

  it("refuses a form missing a contact field", () => {
    // Caught when the version is PUBLISHED, and again when a subject-less
    // link is issued — so the failure never lands on a stranger who has
    // already filled the form in.
    const noEmail = parseFields(base.slice(0, 2));
    expect(() => assertProspectContactFields(noEmail)).toThrow(/must include a "email"/);
  });

  it("refuses optional contact fields", () => {
    const optional = parseFields([
      field({ key: "first_name", required: false }),
      field({ key: "last_name" }),
      field({ key: "email", type: "email" }),
    ]);
    expect(() => assertProspectContactFields(optional)).toThrow(/must be required/);
  });

  it("refuses a contact field marked sensitive", () => {
    // A sensitive email routes to the gated health rows, so promotion
    // would find nothing and the prospect would arrive nameless — while
    // the answer sat in a table meant for something else.
    const sensitiveEmail = parseFields([
      field({ key: "first_name" }),
      field({ key: "last_name" }),
      field({ key: "email", type: "email", sensitive: true }),
    ]);
    expect(() => assertProspectContactFields(sensitiveEmail)).toThrow(/cannot be marked sensitive/);
  });

  it("promotes contact from the answers, not from staff input", () => {
    const fields = parseFields([...base, field({ key: "phone", type: "phone", required: false })]);
    const { answers } = validateAnswers(fields, {
      first_name: " Samuel ",
      last_name: "Adeyemi",
      email: "samuel@example.test",
    });
    const contact = contactFromAnswers(answers);
    expect(contact).toEqual({
      first_name: "Samuel",
      last_name: "Adeyemi",
      email: "samuel@example.test",
      phone: null,
    });
  });
});
