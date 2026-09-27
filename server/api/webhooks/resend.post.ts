import { serverSupabaseServiceRole } from "#supabase/server";
import {
  eventEffect,
  parseResendEvent,
  recipientPatch,
  verifySvixSignature,
} from "~~/server/utils/resendWebhook";

/**
 * POST /api/webhooks/resend
 * Resend's callback channel for campaign engagement (marketing
 * campaigns, phase 2 — docs/design/marketing-campaigns-design.md).
 * Public: Resend POSTs here, no staff session.
 *
 * The discipline, in order:
 *  1. Fail closed: no RESEND_WEBHOOK_SECRET, no service (503).
 *  2. Verify the Svix signature against the RAW body before reading
 *     anything from the payload; a bad signature is the ONLY non-2xx
 *     after that (400).
 *  3. Find the campaign recipient by Resend's email id. Not found means
 *     a transactional email (confirmation, reminder…), which has no
 *     recipient row: acknowledge and ignore.
 *  4. Stamp the recipient's column for the event, first event wins
 *     (redeliveries change nothing); an unsubscribe or a complaint also
 *     sets communication_opted_in = false on the client — the third
 *     writer of that flag, and like the other two it only ever writes
 *     false. A bounce is logged and changes nothing.
 *  5. Always 200. Resend retries non-2xx for a day; a retry storm over
 *     a slow update is worse than acknowledging a duplicate.
 *
 * Registration: Resend dashboard → Webhooks → add the deployed URL,
 * subscribe to opened / clicked / unsubscribed / complained / bounced,
 * copy the signing secret into RESEND_WEBHOOK_SECRET. Cannot be reached
 * from Resend locally; the local proof is a signed simulated POST.
 */
export default defineEventHandler(async (event) => {
  const secret = useRuntimeConfig(event).resendWebhookSecret;
  if (!secret) {
    throw createError({
      statusCode: 503,
      statusMessage:
        "The Resend webhook is not configured on this server (missing RESEND_WEBHOOK_SECRET).",
    });
  }

  const rawBody = (await readRawBody(event, "utf8")) ?? "";
  const verified = verifySvixSignature({
    secret,
    id: getHeader(event, "svix-id"),
    timestamp: getHeader(event, "svix-timestamp"),
    signature: getHeader(event, "svix-signature"),
    rawBody,
  });
  if (!verified) {
    throw createError({ statusCode: 400, statusMessage: "Invalid signature" });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = null;
  }
  const parsed = parseResendEvent(json);
  if (!parsed) return { received: true, ignored: "unparseable" };

  const effect = eventEffect(parsed.type);
  if (!effect.column && !effect.log) return { received: true, ignored: parsed.type };

  const admin = serverSupabaseServiceRole(event);
  const { data: recipient } = await admin
    .from("campaign_recipients")
    .select("id, client_id, organization_id, opened_at, clicked_at, unsubscribed_at")
    .eq("resend_message_id", parsed.emailId)
    .maybeSingle();
  if (!recipient) return { received: true, ignored: "not a campaign recipient" };

  if (effect.log) {
    console.warn(
      `[resend webhook] ${parsed.type} for campaign recipient ${recipient.id} (client ${recipient.client_id})`,
    );
  }

  const patch = recipientPatch(recipient, effect, new Date());
  if (patch) {
    const { error } = await admin
      .from("campaign_recipients")
      .update(patch)
      .eq("id", recipient.id)
      .eq("organization_id", recipient.organization_id);
    if (error) console.error("[resend webhook] recipient update failed:", error.message);
  }

  if (effect.optOut) {
    const { error } = await admin
      .from("clients")
      .update({ communication_opted_in: false })
      .eq("id", recipient.client_id)
      .eq("organization_id", recipient.organization_id);
    if (error) console.error("[resend webhook] opt-out not recorded:", error.message);
  }

  return { received: true, applied: patch ? Object.keys(patch) : [], optOut: effect.optOut };
});
