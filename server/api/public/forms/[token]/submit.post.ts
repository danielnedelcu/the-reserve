import { serverSupabaseServiceRole } from "#supabase/server";
import {
  parseFields,
  validateAnswers,
  contactFromAnswers,
  FormShapeError,
  type AnswerValue,
  type ProspectContact,
} from "~~/shared/forms/fields";
import { assertIpPepperConfigured, clientIp, hashIp } from "../../../../utils/formIp";
import { checkRateLimit, recordAttempt } from "../../../../utils/formRateLimit";

/**
 * POST /api/public/forms/:token/submit
 * PUBLIC (pre-auth) — the app's FIRST unauthenticated write, landing
 * PHI-adjacent data.
 *
 * What protects it, in order:
 *   1. the pepper must be configured, or this route refuses to serve
 *      (a rate limiter that cannot hash cannot count);
 *   2. rate limits, per token and per IP, counted in the database;
 *   3. the token, which is the only authorization — unguessable,
 *      single-use, expiring;
 *   4. shape validation against the version the token FROZE at issue,
 *      rejecting unknown keys rather than dropping them;
 *   5. the sensitivity split, decided here against those frozen flags;
 *   6. an atomic claim-and-write in the database, so single-use holds
 *      under concurrency and anon never touches a table.
 *
 * The route holds no privilege of its own: it runs the service role, and
 * anon has neither an insert policy nor an execute grant anywhere on this
 * path. That is what makes "a direct anon insert fails" structural.
 */
export default defineEventHandler(async (event) => {
  assertIpPepperConfigured();

  const token = getRouterParam(event, "token");
  if (!token) {
    throw createError({ statusCode: 400, statusMessage: "Missing token" });
  }

  const admin = serverSupabaseServiceRole(event);
  const ipHash = hashIp(clientIp(event));

  const limit = await checkRateLimit(admin, token, ipHash);
  if (!limit.allowed) {
    // Recorded too: a rejected attempt still costs the caller a slot,
    // which is what stops an unlimited retry loop.
    await recordAttempt(admin, {
      token,
      ipHash,
      outcome: "rejected",
      organizationId: null,
    });
    throw createError({
      statusCode: 429,
      statusMessage: "Too many attempts. Please wait a while and try again.",
    });
  }

  const body = await readBody<{ answers?: unknown; consented?: boolean }>(event);

  const { data: link } = await admin
    .from("form_links")
    .select(
      "organization_id, client_id, expires_at, consumed_at, revoked_at, form_versions(fields, consent_text)",
    )
    .eq("token", token)
    .maybeSingle();

  const unusable =
    !link ||
    link.consumed_at ||
    link.revoked_at ||
    new Date(link.expires_at) < new Date();

  if (unusable) {
    await recordAttempt(admin, {
      token,
      ipHash,
      outcome: "rejected",
      organizationId: link?.organization_id ?? null,
    });
    throw createError({
      statusCode: 410,
      statusMessage: "This link is no longer valid. Please ask us for a new one.",
    });
  }

  const version = link.form_versions;
  // Decision 5: NO SUBJECT MEANS A PROSPECT LINK. Nothing else. The
  // database function decides the same way (it creates a prospect when
  // client_id is null), and these two must not drift — an earlier version
  // of this route also required the definition key to be prospect_intake,
  // so a subject-less link on any other form sent no contact into a
  // NOT NULL column. The issue route refuses to mint a subject-less link
  // for a version without contact fields, which is what makes this safe.
  const isProspectLink = link.client_id === null;

  let answers: Record<string, AnswerValue>;
  let health: { field_key: string; label: string; answer: AnswerValue }[];
  let contact: ProspectContact | null = null;

  try {
    // Validated against the frozen version, never a current definition:
    // this person answered THESE questions under THESE sensitive flags.
    const fields = parseFields(version.fields);
    const validated = validateAnswers(fields, body?.answers);

    answers = validated.answers;
    health = validated.health.map((h) => ({
      field_key: h.fieldKey,
      label: h.label,
      answer: h.answer,
    }));

    if (isProspectLink) {
      contact = contactFromAnswers(validated.answers);
    }
  } catch (error) {
    await recordAttempt(admin, {
      token,
      ipHash,
      outcome: "rejected",
      organizationId: link.organization_id,
    });
    if (error instanceof FormShapeError) {
      throw createError({
        statusCode: 422,
        statusMessage: error.message,
        data: { fieldKey: error.fieldKey ?? null },
      });
    }
    throw error;
  }

  // The claim and both writes happen inside one transaction in the
  // database. The token is consumed there, not here — a check in this
  // route followed by an insert is a race two simultaneous submits win.
  const { data: responseId, error } = await admin.rpc("submit_form_response", {
    p_token: token,
    p_answers: answers,
    p_health: health,
    // typegen renders a non-defaulted param as non-null, but both the
    // column and the function accept null, and null is the CORRECT value
    // for a version that carries no consent copy — storing "" instead
    // would record that someone agreed to an empty waiver. The cast
    // reconciles the type with the schema, it does not paper over a
    // mismatch: form_versions.consent_text is nullable.
    p_consent_text: version.consent_text as unknown as string,
    p_consented: body?.consented === true,
    p_contact: contact,
  });

  if (error) {
    await recordAttempt(admin, {
      token,
      ipHash,
      outcome: "rejected",
      organizationId: link.organization_id,
    });
    // The claim lost: someone submitted this token between our read and
    // the update. Same message as any other unusable link.
    if (error.message.includes("invalid_or_used_token")) {
      throw createError({
        statusCode: 410,
        statusMessage: "This link is no longer valid. Please ask us for a new one.",
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  await recordAttempt(admin, {
    token,
    ipHash,
    outcome: "accepted",
    organizationId: link.organization_id,
  });

  // Deliberately thin: the submitter learns it worked and nothing about
  // what was stored, which side of the split anything landed on, or who
  // will read it.
  return { submitted: true, responseId };
});
