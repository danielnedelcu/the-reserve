import { serverSupabaseServiceRole } from "#supabase/server";
import {
  leadCaptureSchema,
  LEAD_CAPTURE_MAX_BYTES,
} from "~~/shared/leads/capture";
import { LEAD_HONEYPOT_FIELD } from "~~/shared/leads/constants";
import { assertIpPepperConfigured, clientIp, hashIp } from "../../../utils/formIp";
import {
  checkLeadRateLimit,
  leadCorsOptions,
  leadOrganizationId,
  originIsForbidden,
  recordLeadAttempt,
} from "../../../utils/leadCapture";

/**
 * POST /api/public/leads  (and its CORS preflight)
 * PUBLIC, OPEN — the app's second unauthenticated write, and the more
 * exposed one: the §6 prospect submit is bounded by a single-use token,
 * this is bounded by nothing but what is built here.
 *
 * What protects it, in order:
 *   1. origin — a browser on any site but the marketing site's origins is
 *      refused (browsers enforce this; scripts are not browsers — see 3/4);
 *   2. configuration must be complete, or the route refuses to serve:
 *      the IP pepper (or attempts could not be counted safely) and the
 *      organisation (or a lead would have nowhere to belong);
 *   3. a per-IP rate limit counted in the DATABASE — the single-abuser
 *      bound; a distributed abuser is the known residual;
 *   4. the HONEYPOT — a filled hidden field is discarded and answered
 *      exactly like a success, so the bot is not told it was caught;
 *   5. STRICT shape validation — unknown keys, oversized strings, and any
 *      interest outside the closed set are rejected, not trimmed;
 *   6. the service-role insert. anon holds no policy on `leads` and must
 *      never get one; this route is the only public writer.
 *
 * Consent: the client says whether; the SERVER says when. A client-sent
 * timestamp is not a field the schema accepts.
 *
 * Deliberately thin response: the caller learns it worked, nothing about
 * what was stored or which organisation received it.
 */
export default defineEventHandler(async (event) => {
  const origin = getRequestHeader(event, "origin");

  // 1. Origin. Refused with the same status for preflight and for the
  //    request itself, so a disallowed page cannot even learn the shape.
  if (originIsForbidden(origin)) {
    throw createError({ statusCode: 403, statusMessage: "Origin not allowed" });
  }
  const cors = leadCorsOptions();
  if (isPreflightRequest(event)) {
    appendCorsPreflightHeaders(event, cors);
    return sendNoContent(event, 204);
  }
  if (event.method !== "POST") {
    throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
  }
  appendCorsHeaders(event, cors);

  // 2. Configuration, or refuse.
  assertIpPepperConfigured();
  const organizationId = leadOrganizationId();

  const declared = Number(getRequestHeader(event, "content-length") ?? 0);
  if (declared > LEAD_CAPTURE_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "Request too large" });
  }

  const admin = serverSupabaseServiceRole(event);
  const ipHash = hashIp(clientIp(event));

  // 3. Rate limit — decided before the body is even read, and the refusal
  //    is itself recorded so a retry loop pays for every turn.
  const limit = await checkLeadRateLimit(admin, ipHash);
  if (!limit.allowed) {
    await recordLeadAttempt(admin, { ipHash, outcome: "rejected", organizationId });
    throw createError({
      statusCode: 429,
      statusMessage: "Too many attempts. Please wait a while and try again.",
    });
  }

  const body: unknown = await readBody(event).catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    await recordLeadAttempt(admin, { ipHash, outcome: "rejected", organizationId });
    throw createError({ statusCode: 422, statusMessage: "Expected a JSON object" });
  }

  // 5. Shape (before the honeypot, so a bot cannot use a malformed body
  //    to skip the trap — but the trap's verdict is still success-shaped).
  const parsed = leadCaptureSchema.safeParse(body);
  if (!parsed.success) {
    await recordLeadAttempt(admin, { ipHash, outcome: "rejected", organizationId });
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    throw createError({
      statusCode: 422,
      statusMessage: `${issue?.message ?? "Invalid submission"}${where}`,
      data: { field: issue?.path[0] ?? null },
    });
  }
  const input = parsed.data;

  // 4. Honeypot. Recorded as rejected, answered as accepted.
  if (input[LEAD_HONEYPOT_FIELD]) {
    await recordLeadAttempt(admin, { ipHash, outcome: "rejected", organizationId });
    return { captured: true };
  }

  // 6. The write. Consent is stamped HERE, never taken from the client.
  const consent = input.consent === true;
  const { error } = await admin.from("leads").insert({
    organization_id: organizationId,
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone || null,
    interest: input.interest,
    ...(input.source ? { source: input.source } : {}),
    consent,
    consent_at: consent ? new Date().toISOString() : null,
  });

  if (error) {
    await recordLeadAttempt(admin, { ipHash, outcome: "rejected", organizationId });
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  await recordLeadAttempt(admin, { ipHash, outcome: "accepted", organizationId });
  return { captured: true };
});
