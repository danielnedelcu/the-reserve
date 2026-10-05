/**
 * The form engine's field contract.
 *
 * A form version's `fields` column is jsonb, which Postgres cannot check.
 * These functions ARE the enforcement — the "who enforces what" table in
 * docs/design/prospective-onboarding-design.md names this the one rule
 * with no database backstop, which is why it is also the one with tests.
 *
 * Two jobs, deliberately separate:
 *   parseFields     — is this a valid form DEFINITION? (authoring time)
 *   validateAnswers — do these ANSWERS fit that definition? (submit time)
 *
 * Shared, not server-only, so a future client renderer draws from the same
 * descriptors the server validates against. shared/ is not auto-imported;
 * import explicitly.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "phone",
  "date",
  "boolean",
  "select",
  "multiselect",
] as const;

export type FormFieldType = (typeof FIELD_TYPES)[number];

/**
 * A type alias, NOT an interface, on purpose: interfaces are open to
 * declaration merging so TypeScript refuses them an implicit index
 * signature, and this value is written straight into a jsonb column typed
 * as Json. A type alias satisfies Json structurally — the alternative was
 * casting at the insert, which would switch off checking on exactly the
 * column whose shape everything downstream trusts.
 */
export type FormField = {
  /** Stable key the answer is stored under. Never reused across meanings. */
  key: string;
  /** The question as asked. Snapshotted onto health answers, which are
   *  meaningless without it ("yes" to what?). */
  label: string;
  type: FormFieldType;
  required: boolean;
  /**
   * The switch that decides where an answer lands: true routes it to
   * form_response_health, behind clients.notes.health.view. Anything
   * PHI-adjacent — conditions, medications, injuries, pregnancy — is
   * sensitive. When unsure, mark it sensitive: the cost is an extra
   * permission check, and the cost of the other mistake is a PHI leak.
   */
  sensitive: boolean;
  /** Allowed values for select/multiselect. Required for those types. */
  options?: string[];
  /** Optional helper text shown under the field. */
  help?: string;
}

export class FormShapeError extends Error {
  constructor(
    message: string,
    /** Field key the problem belongs to, when it belongs to one. */
    readonly fieldKey?: string,
  ) {
    super(message);
    this.name = "FormShapeError";
  }
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Shared predicates. Exported so the client-side schema validates with the
 * SAME expressions the server coerces with, rather than a second copy that
 * happens to agree — this file is the authority, and anything checking an
 * answer anywhere should reach for these.
 */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A Date → the day key this contract stores ("YYYY-MM-DD"), by the LOCAL
 * calendar. Deliberately toLocaleDateString("en-CA"), never toISOString():
 * the latter converts to UTC first and, in the evening, lands on tomorrow.
 * This is the only formatter allowed to feed a date answer; isRealDate is
 * its counterpart, and tests/shared/formValidation.test.ts asserts they
 * agree on the awkward days.
 */
export function dateKey(date: Date): string {
  return date.toLocaleDateString("en-CA");
}

/** The inverse of dateKey: a day key → a LOCAL midnight Date, or null. */
export function parseDateKey(value: unknown): Date | null {
  if (typeof value !== "string" || !isRealDate(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** A real calendar date, not just a well-shaped string (2026-02-31 is not). */
export function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * Is this answer absent? The single definition of "unanswered", used by
 * the validator, by the public form before it submits, and by anything
 * else that needs to ask. false is NOT empty — it is the answer "no".
 */
export function isEmptyAnswer(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Validates a form definition's field list. Throws FormShapeError on the
 * first problem — authoring is interactive, so one clear error beats a
 * list nobody reads.
 */
export function parseFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new FormShapeError("A form version needs at least one field.");
  }

  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new FormShapeError(`Field ${i} is not an object.`);
    }
    const f = entry as Record<string, unknown>;

    const key = f.key;
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new FormShapeError(
        `Field ${i} needs a key matching ${KEY_PATTERN} (lowercase, starts with a letter).`,
      );
    }
    if (seen.has(key)) {
      throw new FormShapeError(`Duplicate field key "${key}".`, key);
    }
    seen.add(key);

    const label = f.label;
    if (typeof label !== "string" || label.trim() === "") {
      throw new FormShapeError(`Field "${key}" needs a label.`, key);
    }

    const type = f.type;
    if (typeof type !== "string" || !FIELD_TYPES.includes(type as FormFieldType)) {
      throw new FormShapeError(
        `Field "${key}" has type "${String(type)}"; expected one of ${FIELD_TYPES.join(", ")}.`,
        key,
      );
    }

    // required and sensitive are answered explicitly, never defaulted.
    // A sensitive field defaulting to false is a PHI leak written as a
    // convenience, so the authoring path has to say what it means.
    if (typeof f.required !== "boolean") {
      throw new FormShapeError(`Field "${key}" needs required: true or false.`, key);
    }
    if (typeof f.sensitive !== "boolean") {
      throw new FormShapeError(`Field "${key}" needs sensitive: true or false.`, key);
    }

    let options: string[] | undefined;
    if (type === "select" || type === "multiselect") {
      if (
        !Array.isArray(f.options) ||
        f.options.length === 0 ||
        !f.options.every((o) => typeof o === "string" && o !== "")
      ) {
        throw new FormShapeError(
          `Field "${key}" is a ${type} and needs a non-empty options array of strings.`,
          key,
        );
      }
      options = f.options as string[];
    } else if (f.options !== undefined) {
      throw new FormShapeError(
        `Field "${key}" is type ${type} and cannot carry options.`,
        key,
      );
    }

    if (f.help !== undefined && typeof f.help !== "string") {
      throw new FormShapeError(`Field "${key}" has a non-string help value.`, key);
    }

    return {
      key,
      label: label.trim(),
      type: type as FormFieldType,
      required: f.required,
      sensitive: f.sensitive,
      ...(options ? { options } : {}),
      ...(typeof f.help === "string" ? { help: f.help } : {}),
    };
  });
}

/**
 * Everything coerceValue can emit — and therefore everything that reaches
 * a jsonb column. Narrower than `unknown` on purpose: these values are
 * written straight into jsonb, and a value type that is structurally JSON
 * removes the need to cast at the insert, which would switch off checking
 * at the one boundary where a wrong shape reaches storage.
 */
export type AnswerValue = string | boolean | string[];

/** One sensitive answer, bound for form_response_health. */
export type HealthAnswer = {
  fieldKey: string;
  /** Snapshot of the question, because the version can be superseded. */
  label: string;
  answer: AnswerValue;
};

export type ValidatedAnswers = {
  /** Non-sensitive answers, for form_responses.answers. */
  answers: Record<string, AnswerValue>;
  /** Sensitive answers, for form_response_health — one row each. */
  health: HealthAnswer[];
};

/**
 * Validates a submission against its version's fields and SPLITS it by
 * sensitivity. Unknown keys are rejected rather than dropped: a key the
 * definition does not know is either an attack or a client/server version
 * skew, and silently discarding it would hide both.
 */
export function validateAnswers(
  fields: FormField[],
  raw: unknown,
): ValidatedAnswers {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FormShapeError("Answers must be an object keyed by field.");
  }
  const submitted = raw as Record<string, unknown>;

  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(submitted)) {
    if (!known.has(key)) {
      throw new FormShapeError(`Unknown field "${key}".`, key);
    }
  }

  const answers: Record<string, AnswerValue> = {};
  const health: HealthAnswer[] = [];

  for (const field of fields) {
    const value = submitted[field.key];

    if (isEmptyAnswer(value)) {
      if (field.required) {
        throw new FormShapeError(`"${field.label}" is required.`, field.key);
      }
      continue; // optional and unanswered: store nothing at all
    }

    const coerced = coerceValue(field, value);
    if (field.sensitive) {
      health.push({ fieldKey: field.key, label: field.label, answer: coerced });
    } else {
      answers[field.key] = coerced;
    }
  }

  return { answers, health };
}

/** Type-checks one answer and normalises it. Throws on a mismatch. */
function coerceValue(field: FormField, value: unknown): AnswerValue {
  const bad = (expected: string): never => {
    throw new FormShapeError(
      `"${field.label}" expects ${expected}.`,
      field.key,
    );
  };

  switch (field.type) {
    case "text":
    case "textarea":
    case "phone":
      return typeof value === "string" ? value.trim() : bad("text");

    case "email": {
      if (typeof value !== "string") return bad("an email address");
      const email = value.trim();
      // Deliberately loose: the delivery path is what proves an address,
      // and a strict regex here rejects valid addresses for no gain.
      if (!EMAIL_PATTERN.test(email)) return bad("an email address");
      return email;
    }

    case "date": {
      if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
        return bad("a date as YYYY-MM-DD");
      }
      // Day-granular and kept as the string: never toISOString() a day key
      // (CLAUDE.md), and a Date here would reintroduce the timezone.
      if (!isRealDate(value)) return bad("a real calendar date");
      return value;
    }

    case "boolean":
      return typeof value === "boolean" ? value : bad("true or false");

    case "select":
      if (typeof value !== "string" || !field.options?.includes(value)) {
        return bad(`one of: ${field.options?.join(", ")}`);
      }
      return value;

    case "multiselect": {
      if (!Array.isArray(value)) return bad("a list of choices");
      for (const v of value) {
        if (typeof v !== "string" || !field.options?.includes(v)) {
          return bad(`choices from: ${field.options?.join(", ")}`);
        }
      }
      return [...new Set(value)];
    }
  }
}

/**
 * Reserved contact keys.
 *
 * A prospect's details reach prospect_intake by promotion from their own
 * answers — their answer is the source of truth for facts that become
 * their client record, rather than something staff retype. The mapping is
 * by fixed key rather than a role on the descriptor: adding a role would
 * extend the field contract that decision 2 froze, putting a per-version
 * compatibility seam through the one structure whose value is that it
 * never changes.
 */
export const CONTACT_FIELD_KEYS = ["first_name", "last_name", "email", "phone"] as const;

/** The definition key whose forms must carry the contact fields. */
export const PROSPECT_INTAKE_FORM_KEY = "prospect_intake";

/**
 * Enforced when a prospect-intake version is PUBLISHED, so a form that
 * cannot produce a prospect is rejected while someone is looking at it,
 * rather than at 2am when a stranger submits it.
 */
export function assertProspectContactFields(fields: FormField[]): void {
  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const key of ["first_name", "last_name", "email"] as const) {
    const field = byKey.get(key);
    if (!field) {
      throw new FormShapeError(
        `A form that creates a prospect must include a "${key}" field — it becomes their record.`,
        key,
      );
    }
    if (!field.required) {
      throw new FormShapeError(
        `"${key}" must be required on a form that creates a prospect.`,
        key,
      );
    }
  }

  // Contact fields are promoted into prospect_intake's own columns, which
  // carry no health gating. Marking one sensitive would route it to the
  // gated health rows instead, so the promotion would find nothing and
  // the prospect would arrive nameless — while the answer sat in a table
  // meant for something else entirely.
  for (const key of CONTACT_FIELD_KEYS) {
    const field = byKey.get(key);
    if (field?.sensitive) {
      throw new FormShapeError(
        `"${key}" is a contact field and cannot be marked sensitive — it is promoted to the prospect record, not to health rows.`,
        key,
      );
    }
  }

  const email = byKey.get("email");
  if (email && email.type !== "email") {
    throw new FormShapeError(`"email" must be of type email.`, "email");
  }
}

/**
 * The contact details a submission promotes into prospect_intake.
 * A type alias, like FormField, so it is structurally JSON for the jsonb
 * parameter it is passed as.
 */
export type ProspectContact = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
}

/**
 * Pulls the reserved contact answers out of a validated answer set.
 *
 * Reads from `answers` (never from the health bucket): contact fields are
 * non-sensitive by the publish-time rule above, so anything claiming to be
 * contact data in the health bucket is a definition that should not have
 * been publishable.
 */
export function contactFromAnswers(answers: Record<string, AnswerValue>): ProspectContact {
  const text = (key: string): string => {
    const value = answers[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new FormShapeError(`Missing contact field "${key}".`, key);
    }
    return value.trim();
  };
  const phone = answers.phone;
  return {
    first_name: text("first_name"),
    last_name: text("last_name"),
    email: text("email"),
    phone: typeof phone === "string" && phone.trim() !== "" ? phone.trim() : null,
  };
}
