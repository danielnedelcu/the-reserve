// server/api/clients/[id]/payment-methods.post.ts
//
// Step 2 of saving a card: the browser confirmed the SetupIntent via
// Elements; we VERIFY it with Stripe (never trust the client), then write
// the consent row and the display-fields mirror row. Consent is written
// first because client_payment_methods.consent_id is NOT NULL — the schema
// forbids a card without consent, this route just complies.

import { serverSupabaseServiceRole } from "#supabase/server";

export default defineEventHandler(async (event) => {
  const { client: userClient } = await requireUser(event);

  const { data: allowed } = await userClient.rpc("has_permission", {
    perm: "cards.manage",
  });
  if (allowed !== true) {
    throw createError({
      statusCode: 403,
      statusMessage: "Missing permission: cards.manage",
    });
  }

  const clientId = getRouterParam(event, "id");
  const body = await readBody<{ setupIntentId?: string; policyText?: string }>(
    event,
  );
  if (!clientId || !body?.setupIntentId || !body?.policyText?.trim()) {
    throw createError({
      statusCode: 422,
      statusMessage: "setupIntentId and policyText are required",
    });
  }

  const admin = serverSupabaseServiceRole(event);

  const { data: client } = await admin
    .from("clients")
    .select("id, organization_id, stripe_customer_id")
    .eq("id", clientId)
    .maybeSingle();
  if (!client)
    throw createError({ statusCode: 404, statusMessage: "Client not found" });

  // Who is capturing consent (staff id from the session user).
  const { data: staffId } = await userClient.rpc("current_staff_id");
  if (!staffId)
    throw createError({ statusCode: 403, statusMessage: "No staff record" });

  // Verify with Stripe: succeeded, and belongs to THIS client's customer.
  const stripe = useStripe();
  const setupIntent = await stripe.setupIntents.retrieve(body.setupIntentId);
  if (setupIntent.status !== "succeeded") {
    throw createError({
      statusCode: 422,
      statusMessage: "Card setup not completed",
    });
  }
  if (setupIntent.customer !== client.stripe_customer_id) {
    throw createError({
      statusCode: 422,
      statusMessage: "Setup does not match this client",
    });
  }
  const pmId =
    typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
  if (!pmId)
    throw createError({
      statusCode: 422,
      statusMessage: "No payment method on setup",
    });

  const paymentMethod = await stripe.paymentMethods.retrieve(pmId);
  const card = paymentMethod.card;
  if (!card)
    throw createError({
      statusCode: 422,
      statusMessage: "Not a card payment method",
    });

  // 1) Consent (append-only)
  const { data: consent, error: consentError } = await admin
    .from("card_consents")
    .insert({
      organization_id: client.organization_id,
      client_id: client.id,
      captured_by: staffId,
      method: "front_desk_attested",
      policy_text: body.policyText.trim(),
    })
    .select("id")
    .single();
  if (consentError || !consent) {
    console.error("[payment-methods] consent insert failed:", consentError);
    throw createError({
      statusCode: 500,
      statusMessage: "Could not record consent",
    });
  }

  // 2) The mirror row (display fields only)
  const { error: pmError } = await admin.from("client_payment_methods").insert({
    organization_id: client.organization_id,
    client_id: client.id,
    consent_id: consent.id,
    stripe_payment_method_id: paymentMethod.id,
    brand: card.brand,
    last4: card.last4,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
  });
  if (pmError) {
    console.error("[payment-methods] mirror insert failed:", pmError);
    throw createError({
      statusCode: 500,
      statusMessage: "Could not save card",
    });
  }

  return { saved: true, brand: card.brand, last4: card.last4 };
});
