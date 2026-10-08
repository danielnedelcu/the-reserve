import { serverSupabaseServiceRole } from "#supabase/server";
import {
  CANCEL_LINK_INVALID_MESSAGE,
  loadCancelLink,
} from "~~/server/utils/cancelLink";
import {
  LATE_CANCELLATION_FEE_CENTS,
  consumesWaiver,
} from "~~/server/utils/cancellationPolicy";
import { chargeSavedCard } from "~~/server/utils/chargeSavedCard";
import { writeLedgerTransaction } from "~~/server/utils/ledgerWrite";
import { notifyStaffWithPermission } from "~~/server/utils/notifyStaff";
import { sendMail } from "~~/server/utils/mailer";
import { cancellationNoticeEmail } from "~~/server/utils/emailTemplates";

/**
 * POST /api/public/cancel/:token
 * PUBLIC (pre-auth). The cancel-via-link action and the fee engine
 * (client communications, phase 4 — docs/design/client-communications-design.md).
 *
 * The token is the ONLY authorization: no body, no client or appointment
 * id, nothing a stranger could vary. Service role throughout, since
 * cancellation_tokens has no policies for anyone by design.
 *
 * The sequence, and why it is in this order:
 *  1. Claim the token in ONE statement that both checks and sets used_at.
 *     This is the mutex: two clicks, one winner, the other sees the same
 *     "no longer valid" message as a dead link.
 *  2. Money moves BEFORE anything is written (the ledger rule). If the fee
 *     is due and a card is on file, it is charged now, with an idempotency
 *     key so a retry can never charge twice. If the charge FAILS the
 *     appointment is NOT cancelled and the claim is released: the person
 *     is told plainly and asked to call. A card that exists and declines
 *     is not the same as no card at all — the no-card case proceeds and
 *     leaves the fee to collect; a failed charge does not.
 *  3. The appointment is cancelled — the person's actual request.
 *  4. The ledger records the charge (positive: a fee is money in), then
 *     the waiver flag, the staff notification for an uncollected fee, the
 *     audit row, and the notice email. Every step after the cancellation
 *     is best-effort and loud: a failed ledger write is caught by the
 *     webhook's orphan reconciliation, a failed email is logged, and none
 *     of them undoes the cancellation the person was just promised.
 *
 * The actor on the money and audit rows is the organisation's system
 * staff row — no person did this.
 */
export default defineEventHandler(async (event) => {
  const tokenId = getRouterParam(event, "token") ?? "";
  const admin = serverSupabaseServiceRole(event);
  const now = new Date();

  const link = await loadCancelLink(admin, tokenId, now);
  if (link.state === "invalid") {
    throw createError({ statusCode: 410, statusMessage: CANCEL_LINK_INVALID_MESSAGE });
  }
  if (link.state === "already_cancelled") {
    throw createError({
      statusCode: 409,
      statusMessage: "This appointment has already been cancelled.",
    });
  }

  const { appointment, client, card, outcome, feeCents } = link;

  // 1. The atomic claim. Check and set in the same statement; zero rows
  // means someone (or some other click) got here first.
  const { data: claimed, error: claimError } = await admin
    .from("cancellation_tokens")
    .update({ used_at: now.toISOString() })
    .eq("id", link.token.id)
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("id");
  if (claimError || !claimed?.length) {
    throw createError({ statusCode: 410, statusMessage: CANCEL_LINK_INVALID_MESSAGE });
  }

  // 2. Money first.
  let paymentIntentId: string | null = null;
  if (outcome === "charge" && card && client.stripe_customer_id) {
    const charged = await chargeSavedCard(useStripe(), {
      amountCents: feeCents,
      stripeCustomerId: client.stripe_customer_id,
      stripePaymentMethodId: card.stripe_payment_method_id,
      metadata: {
        reserve_client_id: appointment.client_id,
        reserve_appointment_id: appointment.id,
        reserve_reason: "late_cancellation_fee",
      },
      idempotencyKey: `late-cancellation-fee-${link.token.id}`,
    });
    if (!charged.ok) {
      // Release the claim so the person can try again once the card is
      // sorted out; the link stays live until the appointment starts.
      await admin
        .from("cancellation_tokens")
        .update({ used_at: null })
        .eq("id", link.token.id);
      console.warn(
        `[cancel link] fee charge failed for appointment ${appointment.id}: ${charged.message}`,
      );
      throw createError({
        statusCode: 402,
        statusMessage:
          "We could not charge the card on file, so the appointment has not been cancelled. Please call us and we will take care of it.",
      });
    }
    paymentIntentId = charged.paymentIntentId;
  }

  // 3. The cancellation itself. Same columns the staff path sets;
  // cancelled_by stays null because no staff member did this, and the
  // reason names the path so reports can tell the two apart.
  const { error: cancelError } = await admin
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: now.toISOString(),
      cancel_reason: "client_via_link",
      cancelled_by: null,
    })
    .eq("id", appointment.id);
  if (cancelError) {
    console.error(
      `[cancel link] appointment ${appointment.id} not cancelled after claim` +
        (paymentIntentId ? ` — fee ${paymentIntentId} WAS charged` : "") +
        `: ${cancelError.message}`,
    );
    throw createError({
      statusCode: 500,
      statusMessage:
        "Something went wrong cancelling the appointment. Please call us.",
    });
  }

  const { data: systemStaffId } = await admin.rpc("system_staff_id", {
    p_organization_id: appointment.organization_id,
  });

  // 4a. The ledger: one transaction, one fee line, one card payment, in
  // ONE call keyed by the PaymentIntent, so a retry cannot record the fee
  // twice (docs/design/ledger-integrity-design.md).
  let transactionId: string | null = null;
  if (paymentIntentId && systemStaffId) {
    try {
      transactionId = await writeLedgerTransaction(admin, {
        organizationId: appointment.organization_id,
        idempotencyKey: `pi:${paymentIntentId}`,
        header: {
          location_id: appointment.location_id,
          client_id: appointment.client_id,
          appointment_id: appointment.id,
          subtotal_cents: feeCents,
          discount_cents: 0,
          tax_cents: 0,
          tip_cents: 0,
          total_cents: feeCents,
          checked_out_by: systemStaffId,
          note: "Late cancellation fee (cancelled via link)",
        },
        items: [
          {
            kind: "late_cancellation_fee",
            appointment_id: appointment.id,
            product_id: null,
            gift_card_id: null,
            staff_id: null,
            name_snapshot: `Late cancellation fee (${appointment.serviceName})`,
            quantity: 1,
            unit_price_cents: feeCents,
            taxable: false,
            tax_cents: 0,
            total_cents: feeCents,
            discount_reason: null,
          },
        ],
        payments: [
          {
            method: "stripe_card",
            amount_cents: feeCents,
            gift_card_id: null,
            reference: paymentIntentId,
            stripe_payment_intent_id: paymentIntentId,
          },
        ],
      });
    } catch (ledgerError) {
      // Nothing half-written: the function wrote all or nothing. The
      // webhook then flags the intent as orphaned, loudly.
      console.error(
        `[cancel link] ORPHANED fee ${paymentIntentId}: charged, no ledger row:`,
        (ledgerError as { statusMessage?: string; message?: string }).statusMessage ?? (ledgerError as Error).message,
      );
    }
  } else if (paymentIntentId) {
    console.error(
      `[cancel link] ORPHANED fee ${paymentIntentId}: no system staff row for org ${appointment.organization_id}`,
    );
  }

  // 4b. The waiver is spent only when it was actually used.
  if (consumesWaiver(outcome)) {
    const { error } = await admin
      .from("clients")
      .update({ late_cancellation_waiver_used: true })
      .eq("id", appointment.client_id);
    if (error) {
      console.error("[cancel link] waiver flag not set:", error.message);
    }
  }

  // 4c. No card: the fee is owed, and the people who ring up checkouts
  // need to know at the next visit.
  const when = new Date(appointment.starts_at).toLocaleString("en-US", {
    timeZone: appointment.location.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (outcome === "uncollected") {
    await notifyStaffWithPermission(
      admin,
      "pos.checkout",
      {
        kind: "cancellation_fee_uncollected",
        title: "Late cancellation fee to collect",
        body: `${client.first_name} ${client.last_name} cancelled ${appointment.serviceName} (${when}) within 24 hours. No card on file — collect the $${(feeCents / 100).toFixed(2)} fee at their next visit.`,
        link: `/clients/${appointment.client_id}`,
      },
      "[cancel link] notify",
    );
  }

  // 4d. Audit, attributed to the system.
  await admin.from("audit_log").insert({
    actor_staff_id: systemStaffId ?? null,
    actor_user_id: null,
    action: "appointment.cancelled_via_link",
    entity_type: "appointment",
    entity_id: appointment.id,
    detail: {
      client_id: appointment.client_id,
      token_id: link.token.id,
      starts_at: appointment.starts_at,
      late: link.late,
      fee_outcome: outcome,
      fee_cents: feeCents,
      stripe_payment_intent_id: paymentIntentId,
      transaction_id: transactionId,
    },
  });

  // 4e. Touchpoint 3. Logged only when a message actually left.
  // TODO(sms): communication_channel is recorded but delivery is
  // email-only until the SMS phase.
  if (client.email) {
    const content = cancellationNoticeEmail({
      clientFirstName: client.first_name,
      serviceName: appointment.serviceName,
      staffName: appointment.staffName,
      startsAtIso: appointment.starts_at,
      timezone: appointment.location.timezone,
      locationName: appointment.location.name,
      outcome,
      feeCents: LATE_CANCELLATION_FEE_CENTS,
      cardLast4: outcome === "charge" ? (card?.last4 ?? null) : null,
    });
    const emailed = await sendMail({ to: client.email, ...content });
    if (emailed) {
      const { error } = await admin.from("communications_sent").insert({
        organization_id: appointment.organization_id,
        client_id: appointment.client_id,
        appointment_id: appointment.id,
        kind: "cancellation_notice",
        channel: "email",
        metadata: {
          service_name: appointment.serviceName,
          starts_at: appointment.starts_at,
          fee_outcome: outcome,
          fee_cents: feeCents,
          stripe_payment_intent_id: paymentIntentId,
        },
      });
      if (error) {
        console.error("[cancel link] notice sent but not logged:", error.message);
      }
    } else {
      console.warn(
        `[cancel link] cancellation notice not sent for appointment ${appointment.id}`,
      );
    }
  }

  return {
    outcome,
    feeCents,
    policyFeeCents: LATE_CANCELLATION_FEE_CENTS,
    cardLast4: outcome === "charge" ? (card?.last4 ?? null) : null,
  };
});
