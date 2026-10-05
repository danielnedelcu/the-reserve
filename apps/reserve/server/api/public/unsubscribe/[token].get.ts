import { serverSupabaseServiceRole } from "#supabase/server";
import { isValidTokenId } from "~~/server/utils/campaigns";

/**
 * GET /api/public/unsubscribe/:token
 * PUBLIC (pre-auth). The one-click unsubscribe behind every campaign
 * email (marketing campaigns, phase 1). Door 0, the cancel link's
 * pattern: the token is the only authorization, the route runs under
 * the service role, and nothing here accepts a client id.
 *
 * Claims the token in the same statement that checks it is unused, then
 * sets communication_opted_in = false on THAT token's client. One flag,
 * one client. Transactional mail (confirmations, reminders, cancellation
 * notices) is unaffected by the flag and the page says so.
 *
 * Invalid, malformed and already-used tokens all get the same 410; the
 * page renders one message for them, and the person's remedy is the
 * same in every case.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token");
  if (!isValidTokenId(token)) {
    throw createError({ statusCode: 410, statusMessage: "This unsubscribe link has already been used or is invalid." });
  }
  const admin = serverSupabaseServiceRole(event);

  const { data: claimed } = await admin
    .from("campaign_unsubscribe_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", token)
    .is("used_at", null)
    .select("client_id");
  const clientId = claimed?.[0]?.client_id;
  if (!clientId) {
    throw createError({ statusCode: 410, statusMessage: "This unsubscribe link has already been used or is invalid." });
  }

  const { error } = await admin
    .from("clients")
    .update({ communication_opted_in: false })
    .eq("id", clientId);
  if (error) {
    // The token is claimed but the flag did not flip: release the claim
    // so a retry can finish the job, and say so plainly.
    await admin
      .from("campaign_unsubscribe_tokens")
      .update({ used_at: null })
      .eq("id", token);
    console.error("[unsubscribe] opt-out not recorded:", error.message);
    throw createError({
      statusCode: 500,
      statusMessage: "We could not record your request. Please try the link again.",
    });
  }

  return { unsubscribed: true };
});
