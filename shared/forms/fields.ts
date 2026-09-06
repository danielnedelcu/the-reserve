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

/** One sensitive answer, bound for form_response_health. */
export interface HealthAnswer {
  fieldKey: string;
  /** Snapshot of the question, because the version can be superseded. */
  label: string;
  answer: unknown;
}

export interface ValidatedAnswers {
  /** Non-sensitive answers, for form_responses.answers. */
  answers: Record<string, unknown>;
  /** Sensitive answers, for form_response_health — one row each. */
  health: HealthAnswer[];
}

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

  const answers: Record<string, unknown> = {};
  const health: HealthAnswer[] = [];

  for (const field of fields) {
    const value = submitted[field.key];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);

    if (empty) {
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
function coerceValue(field: FormField, value: unknown): unknown {
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
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return bad("an email address");
      }
      return email;
    }

    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return bad("a date as YYYY-MM-DD");
      }
      // Day-granular and stored as the string: never toISOString() a day
      // key (CLAUDE.md), and a Date here would reintroduce the timezone.
      const [y, m, d] = value.split("-").map(Number) as [number, number, number];
      const probe = new Date(Date.UTC(y, m - 1, d));
      if (
        probe.getUTCFullYear() !== y ||
        probe.getUTCMonth() !== m - 1 ||
        probe.getUTCDate() !== d
      ) {
        return bad("a real calendar date");
      }
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
