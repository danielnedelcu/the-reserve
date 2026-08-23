// server/api/clients/[id]/setup-intent.post.ts
//
// Step 1 of saving a card: ensure the client has a Stripe Customer,
// create a SetupIntent, hand the client_secret to the browser so
// Stripe Elements can collect the card (the PAN never touches us).

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
  if (!clientId)
    throw createError({ statusCode: 400, statusMessage: "Missing client id" });

  const admin = serverSupabaseServiceRole(event);
  const { data: client } = await admin
    .from("clients")
    .select("id, first_name, last_name, email, stripe_customer_id")
    .eq("id", clientId)
    .maybeSingle();
  if (!client)
    throw createError({ statusCode: 404, statusMessage: "Client not found" });

  const stripe = useStripe();

  // Lazily create the Stripe Customer on first interaction.
  let customerId = client.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: `${client.first_name} ${client.last_name}`,
      email: client.email ?? undefined,
      metadata: { reserve_client_id: client.id },
    });
    customerId = customer.id;
    const { error: saveError } = await admin
      .from("clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
    if (saveError) {
      console.error("[setup-intent] failed to store customer id:", saveError);
      throw createError({
        statusCode: 500,
        statusMessage: "Could not link Stripe customer",
      });
    }
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"], // plain card entry — no Link (front desk enters the CLIENT's card)
  });

  return { clientSecret: setupIntent.client_secret };
});
