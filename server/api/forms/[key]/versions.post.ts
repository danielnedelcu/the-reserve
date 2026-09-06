import { requirePermission } from "../../../utils/requireUser";
import {
  getDefinition,
  publishVersion,
  formShapeError,
} from "../../../utils/formEngine";

/**
 * POST /api/forms/:key/versions
 * Body: { fields, consentText? }
 *
 * Publishes the NEXT version. Editing a form is always this — versions are
 * immutable, and responses reference the one they answered, so changing a
 * published version in place would rewrite what people agreed to.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.manage");
  const key = getRouterParam(event, "key");
  if (!key) {
    throw createError({ statusCode: 400, statusMessage: "Form key is required" });
  }

  const body = await readBody<{ fields?: unknown; consentText?: string | null }>(event);

  const definition = await getDefinition(client, key);
  if (!definition) {
    throw createError({ statusCode: 404, statusMessage: `No form with key "${key}"` });
  }

  try {
    return {
      version: await publishVersion(
        client,
        definition.id,
        definition.key,
        body?.fields,
        body?.consentText ?? null,
      ),
    };
  } catch (error) {
    formShapeError(error);
  }
});
