import { requirePermission } from "../../utils/requireUser";
import { createDefinition, formShapeError } from "../../utils/formEngine";

/**
 * POST /api/forms
 * Body: { key, name, description?, fields, consentText? }
 *
 * Creates a definition and publishes its version 1 together — a definition
 * with no version is answerable by nobody.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.manage");
  const body = await readBody<{
    key?: string;
    name?: string;
    description?: string | null;
    fields?: unknown;
    consentText?: string | null;
  }>(event);

  if (!body?.key || !body.name) {
    throw createError({
      statusCode: 400,
      statusMessage: "key and name are required",
    });
  }

  const { data: orgId } = await client.rpc("current_org_id");
  if (!orgId) {
    throw createError({ statusCode: 403, statusMessage: "No organization in scope" });
  }

  try {
    return {
      definition: await createDefinition(client, orgId, {
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        fields: body.fields,
        consentText: body.consentText ?? null,
      }),
    };
  } catch (error) {
    formShapeError(error);
  }
});
