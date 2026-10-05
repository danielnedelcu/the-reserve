import { z } from "zod";
import {
  EMAIL_PATTERN,
  isRealDate,
  isEmptyAnswer,
  type FormField,
} from "./fields";

/**
 * A Zod schema built from a form version's fields, for live feedback while
 * someone is filling the form in.
 *
 * THIS IS NOT A SECOND VALIDATOR. The server's validateAnswers is the
 * authority and always runs; this exists so a person sees "we need your
 * email address" under the box instead of discovering it after pressing
 * send. Both are built from the SAME field descriptors and the same shared
 * predicates (EMAIL_PATTERN, isRealDate, isEmptyAnswer) — deliberately, so
 * they cannot drift into disagreeing about the edges.
 *
 * tests/shared/formValidation.test.ts asserts that agreement directly,
 * because "two code paths deciding the same predicate" has already caused
 * five separate bugs in this feature — the last one being a client that
 * treated `false` as unanswered while the server treated it as "no".
 */

/** Human wording for the messages a person actually reads. */
function requiredMessage(field: FormField): string {
  return `Please answer "${field.label}".`;
}

function fieldSchema(field: FormField): z.ZodTypeAny {
  const required = field.required;

  switch (field.type) {
    case "email": {
      const base = z
        .string()
        .trim()
        .refine((v) => v === "" || EMAIL_PATTERN.test(v), {
          message: "That does not look like an email address.",
        });
      return required
        ? base.refine((v) => v !== "", { message: requiredMessage(field) })
        : base.optional();
    }

    case "date": {
      const base = z
        .string()
        .trim()
        .refine((v) => v === "" || isRealDate(v), {
          message: "Please enter a real date.",
        });
      return required
        ? base.refine((v) => v !== "", { message: requiredMessage(field) })
        : base.optional();
    }

    case "text":
    case "textarea":
    case "phone": {
      const base = z.string().trim();
      return required
        ? base.min(1, { message: requiredMessage(field) })
        : base.optional();
    }

    case "boolean": {
      // Required means a choice was MADE, not that the answer is yes —
      // "no" is an answer, and the form must be able to record it.
      return required
        ? z.boolean({ message: requiredMessage(field) })
        : z.boolean().optional();
    }

    case "select": {
      const options = (field.options ?? []) as [string, ...string[]];
      const base = z.enum(options, {
        message: "Please choose one of the options.",
      });
      return required ? base : base.optional();
    }

    case "multiselect": {
      const options = (field.options ?? []) as [string, ...string[]];
      const base = z.array(z.enum(options));
      return required
        ? base.min(1, { message: requiredMessage(field) })
        : base.optional();
    }
  }
}

/** The schema for one version's answers, keyed exactly as the fields are. */
export function buildAnswerSchema(fields: FormField[]) {
  return z.object(
    Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f)])),
  );
}

/**
 * Would the server accept this set of answers?
 *
 * Used to decide whether the send button is enabled. Intentionally asks the
 * question the same way the server does — every required field answered,
 * where "answered" is isEmptyAnswer's definition — rather than relying on
 * the Zod pass alone, which cannot see a key that was never submitted.
 */
export function requiredAnswersPresent(
  fields: FormField[],
  answers: Record<string, unknown>,
): boolean {
  return fields
    .filter((f) => f.required)
    .every((f) => !isEmptyAnswer(answers[f.key]));
}
