import { serverSupabaseServiceRole } from "#supabase/server";
import {
  CANCEL_LINK_INVALID_MESSAGE,
  loadCancelLink,
  publicCancelSummary,
} from "~~/server/utils/cancelLink";
import { LATE_CANCELLATION_FEE_CENTS } from "~~/server/utils/cancellationPolicy";

/**
 * GET /api/public/cancel/:token
 * PUBLIC (pre-auth). What the cancel page needs to render: the
 * appointment in plain terms and what cancelling it NOW would cost, so
 * the person can decide with the fee in front of them, not after.
 *
 * Does NOT claim the token — opening the page must be repeatable, or a
 * refresh would kill the link before the person had decided. The POST
 * claims it, atomically. Same token-gated shape as the public form GET:
 * service role, token is the authorization, one message for every
 * unusable state so nothing confirms to a stranger which tokens exist.
 *
 * Returns first names and the appointment's own details — the same
 * things the confirmation email already put in front of this person —
 * and nothing else about the client.
 */
export default defineEventHandler(async (event) => {
  const tokenId = getRouterParam(event, "token") ?? "";
  const admin = serverSupabaseServiceRole(event);

  const link = await loadCancelLink(admin, tokenId, new Date());
  if (link.state === "invalid") {
    throw createError({
      statusCode: 410,
      statusMessage: CANCEL_LINK_INVALID_MESSAGE,
    });
  }

  if (link.state === "already_cancelled") {
    return { state: "already_cancelled" as const, ...publicCancelSummary(link) };
  }

  return {
    state: "ready" as const,
    ...publicCancelSummary(link),
    // The preview of the fee decision, computed by the same function the
    // POST will run. A late cancellation with a card on file shows the
    // last four so the person knows which card is about to be charged.
    late: link.late,
    outcome: link.outcome,
    /** Owed if they confirm now (0 when waived or in time). */
    feeCents: link.feeCents,
    /** The policy's amount, for "after this, late cancellations cost…". */
    policyFeeCents: LATE_CANCELLATION_FEE_CENTS,
    cardLast4: link.outcome === "charge" ? (link.card?.last4 ?? null) : null,
  };
});
