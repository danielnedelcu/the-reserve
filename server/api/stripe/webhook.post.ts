// server/api/stripe/webhook.post.ts
//
// Stripe's callback channel. Design (per migration4b-design.md):
// - The SYNC checkout flow drives ledger writes; this route RECONCILES.
// - Signature verification before anything (raw body required).
// - Idempotency: insert event id into stripe_events; conflict = duplicate
//   delivery, 200 and done.
// - Always answer 200 fast; Stripe retries non-200s for days.
//
// Registration (dev): stripe listen --forward-to localhost:3000/api/stripe/webhook
// Registration (prod): Dashboard -> Developers -> Webhooks -> add endpoint.
// Either yields the signing secret -> STRIPE_WEBHOOK_SECRET in .env.

import type Stripe from "stripe";
import { serverSupabaseServiceRole } from "#supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~~/shared/types/database";

export default defineEventHandler(async (event) => {
  const stripe = useStripe();
  const secret = useRuntimeConfig().stripeWebhookSecret;
  if (!secret) {
    console.error("[stripe webhook] STRIPE_WEBHOOK_SECRET not configured");
    throw createError({
      statusCode: 500,
      statusMessage: "Webhook not configured",
    });
  }

  // 1. Verify the signature against the RAW body (parsed JSON won't verify).
  const signature = getHeader(event, "stripe-signature");
  const rawBody = await readRawBody(event);
  if (!signature || !rawBody) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing signature or body",
    });
  }

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // Bad signature: not Stripe, or wrong secret. Reject without detail.
    throw createError({ statusCode: 400, statusMessage: "Invalid signature" });
  }

  const admin = serverSupabaseServiceRole(event);

  // 2. Idempotency: first delivery inserts; retries collide and exit.
  const { error: dupeError } = await admin
    .from("stripe_events")
    .insert({ id: stripeEvent.id, type: stripeEvent.type });
  if (dupeError) {
    if (dupeError.code === "23505") {
      return { received: true, duplicate: true }; // genuine redelivery
    }
    // Anything else (clock skew, transient DB failure): fail loudly so
    // Stripe retries — a 200 here would silently drop the event.
    console.error("[stripe webhook] event insert failed:", dupeError);
    throw createError({
      statusCode: 500,
      statusMessage: "Event recording failed",
    });
  }
  // 3. Handlers. Cheap work inline; anything heavy would be deferred.
  try {
    switch (stripeEvent.type) {
      // Reconciliation: the sync flow already wrote the ledger. A success
      // with NO matching payment row is the timeout edge -> loud flag.
      case "payment_intent.succeeded": {
        const intent = stripeEvent.data.object as Stripe.PaymentIntent;
        const { data: match } = await admin
          .from("payments")
          .select("id")
          .eq("stripe_payment_intent_id", intent.id)
          .maybeSingle();
        if (!match) {
          console.error(
            `[stripe webhook] ORPHANED payment_intent ${intent.id} (${intent.amount}): money moved, no ledger row. Manual reconciliation needed.`,
          );
          await notifyAdmins(admin, {
            kind: "stripe_alert",
            title: "Stripe payment needs reconciliation",
            body: `PaymentIntent ${intent.id} succeeded ($${(intent.amount / 100).toFixed(2)}) but no ledger row matches. Likely a checkout timeout — verify in the Stripe dashboard.`,
          });
        }
        break;
      }

      // A dispute is money-adversarial and time-sensitive: notify admins.
      case "charge.dispute.created": {
        const dispute = stripeEvent.data.object as Stripe.Dispute;
        await notifyAdmins(admin, {
          kind: "stripe_alert",
          title: "Card dispute opened",
          body: `A client disputed a charge of $${(dispute.amount / 100).toFixed(2)}. Respond in the Stripe dashboard before ${new Date((dispute.evidence_details?.due_by ?? 0) * 1000).toLocaleDateString("en-US")}.`,
        });
        break;
      }

      // Card removed/expired on Stripe's side: deactivate the mirror row.
      case "payment_method.detached": {
        const pm = stripeEvent.data.object as Stripe.PaymentMethod;
        await admin
          .from("client_payment_methods")
          .update({ active: false })
          .eq("stripe_payment_method_id", pm.id);
        break;
      }

      // Card details refreshed (network updater: new expiry/last4).
      case "payment_method.updated":
      case "payment_method.automatically_updated": {
        const pm = stripeEvent.data.object as Stripe.PaymentMethod;
        if (pm.card) {
          await admin
            .from("client_payment_methods")
            .update({
              brand: pm.card.brand,
              last4: pm.card.last4,
              exp_month: pm.card.exp_month,
              exp_year: pm.card.exp_year,
            })
            .eq("stripe_payment_method_id", pm.id);
        }
        break;
      }

      // Refund confirmations arrive here; the refund route already wrote the
      // ledger synchronously, so this is informational.
      case "charge.refunded":
        break;

      default:
        // Unhandled types are fine — we only subscribe to what we handle,
        // but a wildcard subscription shouldn't error either.
        break;
    }
  } catch (handlerError) {
    // The event is recorded in stripe_events; failing the response would
    // only cause redeliveries we'd skip as duplicates. Log loudly instead.
    console.error(
      `[stripe webhook] handler error for ${stripeEvent.type}:`,
      handlerError,
    );
  }

  return { received: true };
});

/** Notify every staff member holding pos.refund (admins+) via the notifications rail. */
async function notifyAdmins(
  admin: SupabaseClient<Database>,
  notification: { kind: string; title: string; body: string },
) {
  const { data: admins, error } = await admin
    .from("staff_roles")
    .select("staff_id, roles!inner(role_permissions!inner(permission_key))")
    .eq("roles.role_permissions.permission_key", "pos.refund");
  if (error) {
    console.error("[stripe webhook] notifyAdmins lookup failed:", error);
    return;
  }
  const ids = [...new Set((admins ?? []).map((row) => row.staff_id))];
  if (!ids.length) return;
  const { error: insertError } = await admin.from("notifications").insert(
    ids.map((staffId) => ({
      staff_id: staffId,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
    })),
  );
  if (insertError) {
    console.error("[stripe webhook] notifyAdmins insert failed:", insertError);
  }
}
