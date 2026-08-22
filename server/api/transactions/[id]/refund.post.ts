import {
  serverSupabaseClient,
  serverSupabaseServiceRole,
} from "#supabase/server";

/**
 * POST /api/transactions/:id/refund — full refund (v1).
 *
 * Creates a NEW transaction with negated amounts referencing the original via
 * refunds_transaction_id. The original is never touched. Triggers do the rest:
 * negative gift_card payments restore balances; negative product items restore
 * stock (pos_refund_fix migration).
 */
export default defineEventHandler(async (event) => {
  await requireUser(event);
  const userClient = await serverSupabaseClient(event);
  const admin = serverSupabaseServiceRole(event);

  const { data: allowed } = await userClient.rpc("has_permission", {
    perm: "pos.refund",
  });
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: "Missing permission: pos.refund",
    });
  }
  const { data: staffId } = await userClient.rpc("current_staff_id");
  const { data: orgId } = await userClient.rpc("current_org_id");

  const originalId = getRouterParam(event, "id");
  const { data: original } = await admin
    .from("transactions")
    .select("*, transaction_items(*), payments(*)")
    .eq("id", originalId)
    .single();

  if (!original || original.organization_id !== orgId) {
    throw createError({
      statusCode: 404,
      statusMessage: "Transaction not found",
    });
  }
  if (original.refunds_transaction_id) {
    throw createError({
      statusCode: 422,
      statusMessage: "This IS a refund transaction",
    });
  }

  // Already refunded?
  const { data: priorRefund } = await admin
    .from("transactions")
    .select("id")
    .eq("refunds_transaction_id", originalId)
    .limit(1);
  if (priorRefund?.length) {
    throw createError({ statusCode: 409, statusMessage: "Already refunded" });
  }

  // Gift cards SOLD in the original: refundable only if unused; deactivate on refund.
  const soldCards = (original.transaction_items ?? []).filter(
    (item: { kind: string; gift_card_id: string | null }) =>
      item.kind === "gift_card" && item.gift_card_id,
  );
  for (const cardItem of soldCards) {
    const { data: card } = await admin
      .from("gift_cards")
      .select("id, initial_balance_cents, balance_cents")
      .eq("id", cardItem.gift_card_id)
      .single();
    if (card && card.balance_cents !== card.initial_balance_cents) {
      throw createError({
        statusCode: 422,
        statusMessage:
          "A gift card from this sale has been partially used — refund it manually",
      });
    }
  }

  // The negative mirror
  const { data: refundTxn, error: txnError } = await admin
    .from("transactions")
    .insert({
      organization_id: orgId,
      location_id: original.location_id,
      client_id: original.client_id,
      appointment_id: original.appointment_id,
      refunds_transaction_id: original.id,
      subtotal_cents: -original.subtotal_cents,
      discount_cents: -original.discount_cents,
      tax_cents: -original.tax_cents,
      tip_cents: -original.tip_cents,
      total_cents: -original.total_cents,
      checked_out_by: staffId,
      note: `Refund of transaction ${original.id.slice(0, 8)}`,
    })
    .select("id")
    .single();
  if (txnError || !refundTxn) {
    throw createError({
      statusCode: 500,
      statusMessage: txnError?.message ?? "Refund write failed",
    });
  }

  const itemRows = (original.transaction_items ?? []).map(
    (item: Record<string, unknown>) => ({
      transaction_id: refundTxn.id,
      kind: item.kind,
      appointment_id: item.appointment_id,
      product_id: item.product_id,
      gift_card_id: item.gift_card_id,
      staff_id: item.staff_id,
      name_snapshot: `Refund — ${item.name_snapshot}`,
      quantity: item.quantity,
      unit_price_cents: -(item.unit_price_cents as number),
      taxable: item.taxable,
      tax_cents: -(item.tax_cents as number),
      total_cents: -(item.total_cents as number),
      discount_reason: item.discount_reason,
    }),
  );
  const { error: itemsError } = await admin
    .from("transaction_items")
    .insert(itemRows);
  if (itemsError) {
    await admin
      .from("transaction_items")
      .delete()
      .eq("transaction_id", refundTxn.id);
    await admin.from("transactions").delete().eq("id", refundTxn.id);
    throw createError({ statusCode: 500, statusMessage: itemsError.message });
  }

  const paymentRows = (original.payments ?? []).map(
    (payment: Record<string, unknown>) => ({
      transaction_id: refundTxn.id,
      method: payment.method,
      amount_cents: -(payment.amount_cents as number),
      gift_card_id: payment.gift_card_id, // negative amount → trigger restores balance
      reference: payment.reference ? `refund: ${payment.reference}` : null,
    }),
  );
  const { error: paymentsError } = await admin
    .from("payments")
    .insert(paymentRows);
  if (paymentsError) {
    await admin.from("payments").delete().eq("transaction_id", refundTxn.id);
    await admin
      .from("transaction_items")
      .delete()
      .eq("transaction_id", refundTxn.id);
    await admin.from("transactions").delete().eq("id", refundTxn.id);
    throw createError({
      statusCode: 500,
      statusMessage: paymentsError.message,
    });
  }

  // Deactivate refunded (unused) gift cards
  for (const cardItem of soldCards) {
    await admin
      .from("gift_cards")
      .update({ active: false })
      .eq("id", cardItem.gift_card_id);
  }

  const { error: auditError } = await admin.from("audit_log").insert({
    actor_staff_id: staffId,
    action: "pos.refund",
    entity_type: "transaction",
    entity_id: original.id,
    detail: {
      refund_transaction_id: refundTxn.id,
      total_cents: -original.total_cents,
    },
  });
  if (auditError) {
    console.error("[refund] audit failed:", auditError);
  }

  return { id: refundTxn.id };
});
