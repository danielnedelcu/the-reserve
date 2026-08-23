// Detach a saved card: Stripe-side removal first (card becomes unchargeable),
// then deactivate the mirror row (never deleted — historical payments
// reference it). The webhook's payment_method.detached handler would also
// deactivate it; doing it here too makes the UI update immediate.
import {
  serverSupabaseClient,
  serverSupabaseServiceRole,
} from "#supabase/server";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const userClient = await serverSupabaseClient(event);

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
  const rowId = getRouterParam(event, "pmId");
  if (!clientId || !rowId) {
    throw createError({ statusCode: 400, statusMessage: "Missing ids" });
  }

  const admin = serverSupabaseServiceRole(event);
  const { data: card } = await admin
    .from("client_payment_methods")
    .select("id, client_id, stripe_payment_method_id, active")
    .eq("id", rowId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!card)
    throw createError({ statusCode: 404, statusMessage: "Card not found" });

  if (card.active) {
    try {
      await useStripe().paymentMethods.detach(card.stripe_payment_method_id);
    } catch (error: unknown) {
      const stripeError = error as { message?: string };
      throw createError({
        statusCode: 502,
        statusMessage: `Could not remove card: ${stripeError.message ?? "Stripe error"}`,
      });
    }
  }

  const { error: updateError } = await admin
    .from("client_payment_methods")
    .update({ active: false })
    .eq("id", card.id);
  if (updateError) {
    console.error("[detach] deactivate failed:", updateError);
    throw createError({
      statusCode: 500,
      statusMessage: "Card removed from Stripe but not locally — refresh",
    });
  }

  return { removed: true };
});
