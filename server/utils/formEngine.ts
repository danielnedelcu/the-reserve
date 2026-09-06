import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "~~/shared/types/database";
import {
  parseFields,
  assertProspectContactFields,
  FormShapeError,
  PROSPECT_INTAKE_FORM_KEY,
  type FormField,
} from "~~/shared/forms/fields";

/**
 * Authoring side of the form engine: definitions and their immutable
 * versions.
 *
 * The invariant this file protects is that a published version never
 * changes. Postgres enforces it (no update/delete policy on form_versions,
 * plus an explicit revoke), so nothing here can weaken it — the job here is
 * to make "edit a form" mean "publish the next version" at the call site
 * too, rather than something that fails confusingly at the database.
 */

type Db = SupabaseClient<Database>;

export interface PublishedVersion {
  id: string;
  version: number;
  fields: FormField[];
  consentText: string | null;
  publishedAt: string;
}

export interface FormDefinitionSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  /** Null only for a definition whose versions were never published. */
  currentVersion: PublishedVersion | null;
}

/** Turns a FormShapeError into a 422 the client can show verbatim. */
export function formShapeError(error: unknown): never {
  if (error instanceof FormShapeError) {
    throw createError({
      statusCode: 422,
      statusMessage: error.message,
      data: { fieldKey: error.fieldKey ?? null },
    });
  }
  throw error;
}

/**
 * Reads a version row's jsonb `fields` back into typed descriptors.
 *
 * Parsing on the way OUT as well as in is deliberate. The column is jsonb;
 * a hand-written row, a restored dump, or a future migration can put
 * anything in it, and every consumer downstream (renderer, validator,
 * health split) trusts these descriptors. Failing here is loud; trusting
 * them is silent.
 */
function readVersion(row: {
  id: string;
  version: number;
  fields: unknown;
  consent_text: string | null;
  published_at: string;
}): PublishedVersion {
  return {
    id: row.id,
    version: row.version,
    fields: parseFields(row.fields),
    consentText: row.consent_text,
    publishedAt: row.published_at,
  };
}

/**
 * Field rules that depend on WHICH form this is.
 *
 * Enforced at publish, so a prospect form that could not produce a
 * prospect is refused while an author is looking at the error — rather
 * than at 2am, when a stranger has already filled it in and the submit
 * path finds no name to promote.
 */
function assertFieldsForKey(formKey: string, fields: FormField[]): void {
  if (formKey === PROSPECT_INTAKE_FORM_KEY) {
    assertProspectContactFields(fields);
  }
}

/** Every definition in the caller's org, each with its newest version. */
export async function listDefinitions(db: Db): Promise<FormDefinitionSummary[]> {
  const { data, error } = await db
    .from("form_definitions")
    .select(
      "id, key, name, description, active, form_versions(id, version, fields, consent_text, published_at)",
    )
    .order("key");

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return (data ?? []).map((row) => {
    const newest = [...(row.form_versions ?? [])].sort(
      (a, b) => b.version - a.version,
    )[0];
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      active: row.active,
      currentVersion: newest ? readVersion(newest) : null,
    };
  });
}

/** One definition by key, with its newest version. Null when absent. */
export async function getDefinition(
  db: Db,
  key: string,
): Promise<FormDefinitionSummary | null> {
  const { data, error } = await db
    .from("form_definitions")
    .select(
      "id, key, name, description, active, form_versions(id, version, fields, consent_text, published_at)",
    )
    .eq("key", key)
    .maybeSingle();

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }
  if (!data) return null;

  const newest = [...(data.form_versions ?? [])].sort(
    (a, b) => b.version - a.version,
  )[0];
  return {
    id: data.id,
    key: data.key,
    name: data.name,
    description: data.description,
    active: data.active,
    currentVersion: newest ? readVersion(newest) : null,
  };
}

export interface CreateDefinitionInput {
  key: string;
  name: string;
  description?: string | null;
  fields: unknown;
  consentText?: string | null;
}

/**
 * Creates a definition and publishes its version 1 in one call.
 *
 * A definition with no version is answerable by nobody, so the two are not
 * offered separately — a half-created form is a state worth not having.
 */
export async function createDefinition(
  db: Db,
  orgId: string,
  input: CreateDefinitionInput,
): Promise<FormDefinitionSummary> {
  const fields = parseFields(input.fields);
  assertFieldsForKey(input.key, fields);

  const definitionRow: Omit<TablesInsert<"form_definitions">, "organization_id"> = {
    key: input.key,
    name: input.name,
    description: input.description ?? null,
  };

  const { data: definition, error: defError } = await db
    .from("form_definitions")
    .insert({ ...definitionRow, organization_id: orgId })
    .select("id, key, name, description, active")
    .single();

  if (defError) {
    // 23505 is unique_violation — one definition per key per org.
    if (defError.code === "23505") {
      throw createError({
        statusCode: 409,
        statusMessage: `A form with key "${input.key}" already exists.`,
      });
    }
    throw createError({ statusCode: 500, statusMessage: defError.message });
  }

  const version = await insertVersion(db, definition.id, 1, fields, input.consentText ?? null);

  return {
    id: definition.id,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    active: definition.active,
    currentVersion: version,
  };
}

/**
 * Publishes the next version of an existing definition.
 *
 * The version number is read then written, which is a race — two
 * simultaneous publishes both compute n+1. That race is CLOSED BY THE
 * DATABASE, not here: unique (form_definition_id, version) rejects the
 * loser, which surfaces as a 409 telling the caller to retry. Serialising
 * in application code would be the weaker fix, since it only holds for
 * callers that go through this function.
 */
export async function publishVersion(
  db: Db,
  definitionId: string,
  formKey: string,
  fieldsInput: unknown,
  consentText: string | null,
): Promise<PublishedVersion> {
  const fields = parseFields(fieldsInput);
  assertFieldsForKey(formKey, fields);

  const { data: latest, error: latestError } = await db
    .from("form_versions")
    .select("version")
    .eq("form_definition_id", definitionId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) {
    throw createError({ statusCode: 500, statusMessage: latestError.message });
  }

  return insertVersion(db, definitionId, (latest?.version ?? 0) + 1, fields, consentText);
}

async function insertVersion(
  db: Db,
  definitionId: string,
  version: number,
  fields: FormField[],
  consentText: string | null,
): Promise<PublishedVersion> {
  const row: TablesInsert<"form_versions"> = {
    form_definition_id: definitionId,
    version,
    fields,
    consent_text: consentText,
  };

  const { data, error } = await db
    .from("form_versions")
    .insert(row)
    .select("id, version, fields, consent_text, published_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw createError({
        statusCode: 409,
        statusMessage:
          "Another version was published at the same moment. Retry to publish on top of it.",
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return readVersion(data);
}
