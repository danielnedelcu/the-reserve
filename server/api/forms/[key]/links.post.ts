import { requirePermission } from "../../../utils/requireUser";
import { getDefinition } from "../../../utils/formEngine";
import {
  assertProspectContactFields,
  FormShapeError,
} from "~~/shared/forms/fields";

/**
 * POST /api/forms/:key/links
 * Body: { deliveryEmail?, clientId?, expiresInDays? }
 *
 * Issues a tokenized link to the form's CURRENT version. Authenticated,
 * low-novelty — the staff_invites shape pointed at a different table.
 *
 * The version is frozen here, at issue: publishing a new version later
 * must not change the questions this recipient sees, or the sensitive
 * flags their answers are split against.
 *
 * No clientId means a prospect link. Issuing creates no prospect row —
 * a prospect comes into being when they answer.
 */
export default defineEventHandler(async (event) => {
  const { client } = await requirePermission(event, "forms.send");
  const key = getRouterParam(event, "key");
  if (!key) {
    throw createError({ statusCode: 400, statusMessage: "Form key is required" });
  }

  const body = await readBody<{
    deliveryEmail?: string;
    clientId?: string;
    expiresInDays?: number;
  }>(event);

  const definition = await getDefinition(client, key);
  if (!definition) {
    throw createError({ statusCode: 404, statusMessage: `No form with key "${key}"` });
  }
  if (!definition.currentVersion) {
    throw createError({
      statusCode: 409,
      statusMessage: `Form "${key}" has no published version to send.`,
    });
  }

  // A link with no subject becomes a PROSPECT on submit, and a prospect
  // needs a name and an email. Refusing here means the failure lands on
  // the staff member issuing the link, with a fixable message, instead of
  // on a stranger who has already filled the form in.
  if (!body?.clientId) {
    try {
      assertProspectContactFields(definition.currentVersion.fields);
    } catch (error) {
      if (error instanceof FormShapeError) {
        throw createError({
          statusCode: 422,
          statusMessage: `"${key}" cannot be sent as a prospect link: ${error.message}`,
          data: { fieldKey: error.fieldKey ?? null },
        });
      }
      throw error;
    }
  }

  const { data: staffId } = await client.rpc("current_staff_id");
  if (!staffId) {
    throw createError({ statusCode: 403, statusMessage: "No staff identity in scope" });
  }
  const { data: orgId } = await client.rpc("current_org_id");
  if (!orgId) {
    throw createError({ statusCode: 403, statusMessage: "No organization in scope" });
  }

  const days = Math.min(Math.max(body?.expiresInDays ?? 14, 1), 90);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const { data, error } = await client
    .from("form_links")
    .insert({
      organization_id: orgId,
      form_version_id: definition.currentVersion.id,
      client_id: body?.clientId ?? null,
      delivery_email: body?.deliveryEmail ?? null,
      issued_by: staffId,
      expires_at: expiresAt,
    })
    .select("id, token, expires_at")
    .single();

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return {
    id: data.id,
    token: data.token,
    expiresAt: data.expires_at,
    // The path the recipient opens. Delivery (email) is the caller's job;
    // this route mints the link, it does not send it.
    path: `/join/${data.token}`,
    formKey: key,
    version: definition.currentVersion.version,
  };
});
