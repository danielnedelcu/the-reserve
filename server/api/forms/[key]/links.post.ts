import { requirePermission } from "../../../utils/requireUser";
import { getDefinition } from "../../../utils/formEngine";
import { sendMail } from "../../../utils/mailer";
import { formLinkEmail } from "../../../utils/emailTemplates";
import {
  assertProspectContactFields,
  FormShapeError,
} from "~~/shared/forms/fields";

/**
 * POST /api/forms/:key/links
 * Body: { deliveryEmail?, clientId?, expiresInDays? }
 *
 * Issues a tokenized link to the form's CURRENT version and, when given
 * an address, EMAILS it. Authenticated, low-novelty — the staff_invites
 * shape pointed at a different table, delivery included.
 *
 * Delivery is best-effort and never fails the issuance: sendMail returns
 * false rather than throwing, and the link is returned either way. A link
 * that exists but was not delivered is recoverable (copy it); a send that
 * took the whole request down with it would lose the link entirely.
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
          statusMessage:
            `"${key}" has no contact questions, so it cannot create a new person. ` +
            `Send it to an existing client instead. (${error.message})`,
          data: { fieldKey: error.fieldKey ?? null, needsClient: true },
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

  // Deliver it, if we were told where to. The URL is built from the
  // request's own origin so a link mailed from staging cannot point at
  // production, or vice versa.
  const path = `/join/${data.token}`;
  let emailed: boolean | null = null;

  if (body?.deliveryEmail) {
    const origin = getRequestURL(event).origin;
    const content = formLinkEmail({
      formUrl: `${origin}${path}`,
      formName: definition.name,
      expiresInDays: days,
    });
    emailed = await sendMail({ to: body.deliveryEmail, ...content });
  }

  return {
    id: data.id,
    token: data.token,
    expiresAt: data.expires_at,
    path,
    formKey: key,
    version: definition.currentVersion.version,
    // null = no address was given, false = we tried and it did not go.
    // The caller shows the link either way; distinguishing the two is what
    // lets the UI say "sent" honestly rather than optimistically.
    emailed,
    deliveryEmail: body?.deliveryEmail ?? null,
  };
});
