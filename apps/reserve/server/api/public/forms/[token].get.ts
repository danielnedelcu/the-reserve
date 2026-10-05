import { serverSupabaseServiceRole } from "#supabase/server";
import { parseFields } from "~~/shared/forms/fields";

/**
 * GET /api/public/forms/:token
 * PUBLIC (pre-auth). Returns what the form page needs to render.
 *
 * Uses the service role because RLS deliberately exposes form_links to
 * nobody but staff — the token is the authorization, the staff_invites
 * pattern. Does NOT consume the token: opening a link must be repeatable,
 * or a refresh would destroy the form before it was filled.
 *
 * Returns only the questions and the consent copy. No org internals, no
 * client details, nothing about who the link was issued to.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token");
  if (!token) {
    throw createError({ statusCode: 400, statusMessage: "Missing token" });
  }

  const admin = serverSupabaseServiceRole(event);

  const { data: link } = await admin
    .from("form_links")
    .select(
      "expires_at, consumed_at, revoked_at, organization_id, form_versions(fields, consent_text, version, form_definitions(name, description))",
    )
    .eq("token", token)
    .maybeSingle();

  // One message for every unusable state. Distinguishing "already used"
  // from "expired" from "never existed" would confirm to a stranger which
  // tokens are real, and the recipient's remedy is identical in all three:
  // ask the front desk for a new link.
  if (
    !link ||
    link.consumed_at ||
    link.revoked_at ||
    new Date(link.expires_at) < new Date()
  ) {
    throw createError({
      statusCode: 410,
      statusMessage: "This link is no longer valid. Please ask us for a new one.",
    });
  }

  const version = link.form_versions;
  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", link.organization_id)
    .single();

  return {
    organizationName: org?.name ?? "",
    formName: version.form_definitions.name,
    formDescription: version.form_definitions.description,
    version: version.version,
    consentText: version.consent_text,
    // Parsed on the way out: the column is jsonb and every consumer
    // downstream trusts these descriptors, so a malformed row should fail
    // here rather than render a form nobody can submit.
    fields: parseFields(version.fields),
  };
});
