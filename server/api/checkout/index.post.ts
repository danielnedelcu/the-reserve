import {
  serverSupabaseClient,
  serverSupabaseServiceRole,
} from "#supabase/server";
import { sendMail } from "~~/server/utils/mailer";
import { receiptEmail } from "~~/server/utils/emailTemplates";

/**
 * POST /api/checkout — the money route.
 *
 * Everything is re-priced SERVER-SIDE from the catalog/appointment snapshots;
 * client-sent amounts are only accepted for tip, discount, and gift-card
 * amounts (which are choices, not prices). The ledger accepts no authenticated
 * inserts, so all writes go through the service role here. Inserts are
 * sequential with cleanup-on-failure; converting to a single DB-transaction
 * RPC is a known hardening TODO.
 *
 * Body:
 * {
 *   clientId?: uuid,
 *   appointmentId?: uuid,           // pre-fills nothing server-side; service
 *                                   // items carry their own appointmentId
 *   items: [
 *     { kind: 'service', appointmentId: uuid },
 *     { kind: 'product', productId: uuid, quantity: number },
 *     { kind: 'gift_card', amountCents: number, recipientName?, recipientEmail? },
 *     { kind: 'discount', amountCents: number, reason: string },
 *     { kind: 'tip', amountCents: number, staffId: uuid },
 *   ],
 *   payments: [
 *     { method: 'card_external', amountCents: number, reference?: string },
 *     { method: 'gift_card', code: string, amountCents: number },
 *     { method: 'cash', amountCents: number },
 *   ],
 *   note?: string
 * }
 */

interface ItemRow {
  kind: string;
  appointment_id: string | null;
  product_id: string | null;
  gift_card_id: string | null;
  staff_id: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price_cents: number;
  taxable: boolean;
  tax_cents: number;
  total_cents: number;
  discount_reason: string | null;
}

function generateGiftCode() {
  // 16 chars, unambiguous alphabet, grouped: XXXX-XXXX-XXXX-XXXX
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)];
  return Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, pick).join(""),
  ).join("-");
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const userClient = await serverSupabaseClient(event);
  const admin = serverSupabaseServiceRole(event);

  // ---- permission gate -----------------------------------------------------
  const { data: allowed } = await userClient.rpc("has_permission", {
    perm: "pos.checkout",
  });
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: "Missing permission: pos.checkout",
    });
  }

  const { data: staffId } = await userClient.rpc("current_staff_id");
  const { data: orgId } = await userClient.rpc("current_org_id");
  if (!staffId || !orgId) {
    throw createError({ statusCode: 403, statusMessage: "No staff record" });
  }

  const body = await readBody(event);
  const items = Array.isArray(body?.items) ? body.items : [];
  const paymentsIn = Array.isArray(body?.payments) ? body.payments : [];
  if (!items.length) {
    throw createError({ statusCode: 422, statusMessage: "Cart is empty" });
  }

  // ---- location + tax rate ---------------------------------------------------
  const { data: location } = await admin
    .from("locations")
    .select("id, tax_rate_bps")
    .eq("organization_id", orgId)
    .limit(1)
    .single();
  if (!location) {
    throw createError({
      statusCode: 422,
      statusMessage: "No location configured",
    });
  }
  const taxRate = location.tax_rate_bps ?? 0;

  // ---- build item rows, all server-priced ------------------------------------
  const rows: ItemRow[] = [];
  // gift cards to create: [{ row index, amount, recipient }]
  const giftCardsToCreate: {
    rowIndex: number;
    amountCents: number;
    recipientName: string | null;
    recipientEmail: string | null;
  }[] = [];

  for (const item of items) {
    if (item.kind === "service") {
      if (!item.appointmentId) {
        throw createError({
          statusCode: 422,
          statusMessage: "Service item missing appointment",
        });
      }
      // Appointment must be in-org and not already checked out
      const { data: appt } = await admin
        .from("appointments")
        .select("id, organization_id, staff_id, client_id, status")
        .eq("id", item.appointmentId)
        .single();
      if (!appt || appt.organization_id !== orgId) {
        throw createError({
          statusCode: 404,
          statusMessage: "Appointment not found",
        });
      }
      if (["cancelled", "no_show"].includes(appt.status)) {
        throw createError({
          statusCode: 422,
          statusMessage: "Appointment was cancelled",
        });
      }
      const { data: existing } = await admin
        .from("transactions")
        .select("id")
        .eq("appointment_id", item.appointmentId)
        .is("refunds_transaction_id", null)
        .limit(1);
      if (existing?.length) {
        throw createError({
          statusCode: 409,
          statusMessage: "Appointment already checked out",
        });
      }
      const { data: services } = await admin
        .from("appointment_services")
        .select("name_snapshot, price_cents")
        .eq("appointment_id", item.appointmentId);
      if (!services?.length) {
        throw createError({
          statusCode: 422,
          statusMessage: "Appointment has no services",
        });
      }
      for (const svc of services) {
        rows.push({
          kind: "service",
          appointment_id: appt.id,
          product_id: null,
          gift_card_id: null,
          staff_id: appt.staff_id,
          name_snapshot: svc.name_snapshot,
          quantity: 1,
          unit_price_cents: svc.price_cents,
          taxable: false, // GA: services non-taxable
          tax_cents: 0,
          total_cents: svc.price_cents,
          discount_reason: null,
        });
      }
    } else if (item.kind === "product") {
      const quantity = Math.floor(Number(item.quantity ?? 1));
      if (!item.productId || quantity < 1 || quantity > 99) {
        throw createError({
          statusCode: 422,
          statusMessage: "Invalid product line",
        });
      }
      const { data: product } = await admin
        .from("products")
        .select("id, organization_id, name, price_cents, taxable, active")
        .eq("id", item.productId)
        .single();
      if (!product || product.organization_id !== orgId || !product.active) {
        throw createError({
          statusCode: 422,
          statusMessage: "Product not available",
        });
      }
      const total = product.price_cents * quantity;
      const tax = product.taxable ? Math.round((total * taxRate) / 10000) : 0;
      rows.push({
        kind: "product",
        appointment_id: null,
        product_id: product.id,
        gift_card_id: null,
        staff_id: null,
        name_snapshot: product.name,
        quantity,
        unit_price_cents: product.price_cents,
        taxable: product.taxable,
        tax_cents: tax,
        total_cents: total,
        discount_reason: null,
      });
    } else if (item.kind === "gift_card") {
      const amount = Math.floor(Number(item.amountCents ?? 0));
      if (amount < 500 || amount > 100000) {
        throw createError({
          statusCode: 422,
          statusMessage: "Gift card amount must be $5–$1000",
        });
      }
      giftCardsToCreate.push({
        rowIndex: rows.length,
        amountCents: amount,
        recipientName: item.recipientName || null,
        recipientEmail: item.recipientEmail || null,
      });
      rows.push({
        kind: "gift_card",
        appointment_id: null,
        product_id: null,
        gift_card_id: null, // filled after creation
        staff_id: null,
        name_snapshot: `Gift card${item.recipientName ? ` for ${item.recipientName}` : ""}`,
        quantity: 1,
        unit_price_cents: amount,
        taxable: false,
        tax_cents: 0,
        total_cents: amount,
        discount_reason: null,
      });
    } else if (item.kind === "discount") {
      const amount = Math.floor(Number(item.amountCents ?? 0));
      const reason = String(item.reason ?? "").trim();
      if (amount < 1 || !reason) {
        throw createError({
          statusCode: 422,
          statusMessage: "Discount needs an amount and a reason",
        });
      }
      rows.push({
        kind: "discount",
        appointment_id: null,
        product_id: null,
        gift_card_id: null,
        staff_id: null,
        name_snapshot: `Discount — ${reason}`,
        quantity: 1,
        unit_price_cents: -amount,
        taxable: false,
        tax_cents: 0,
        total_cents: -amount,
        discount_reason: reason,
      });
    } else if (item.kind === "tip") {
      const amount = Math.floor(Number(item.amountCents ?? 0));
      if (amount < 1 || amount > 100000 || !item.staffId) {
        throw createError({
          statusCode: 422,
          statusMessage: "Invalid tip line",
        });
      }
      rows.push({
        kind: "tip",
        appointment_id: null,
        product_id: null,
        gift_card_id: null,
        staff_id: item.staffId,
        name_snapshot: "Gratuity",
        quantity: 1,
        unit_price_cents: amount,
        taxable: false,
        tax_cents: 0,
        total_cents: amount,
        discount_reason: null,
      });
    } else {
      throw createError({
        statusCode: 422,
        statusMessage: `Unknown item kind: ${item.kind}`,
      });
    }
  }

  // ---- money math -------------------------------------------------------------
  const subtotal = rows
    .filter((r) => ["service", "product", "gift_card"].includes(r.kind))
    .reduce((sum, r) => sum + r.total_cents, 0);
  const discount = -rows
    .filter((r) => r.kind === "discount")
    .reduce((sum, r) => sum + r.total_cents, 0);
  const tax = rows.reduce((sum, r) => sum + r.tax_cents, 0);
  const tip = rows
    .filter((r) => r.kind === "tip")
    .reduce((sum, r) => sum + r.total_cents, 0);
  const total = subtotal - discount + tax + tip;

  if (discount > subtotal) {
    throw createError({
      statusCode: 422,
      statusMessage: "Discount exceeds subtotal",
    });
  }
  if (total < 0) {
    throw createError({
      statusCode: 422,
      statusMessage: "Total cannot be negative",
    });
  }

  // ---- payments: validate sum + gift card balances ------------------------------
  let paymentsSum = 0;
  const paymentRows: {
    method: string;
    amount_cents: number;
    gift_card_id: string | null;
    reference: string | null;
    stripe_payment_intent_id: string | null;
  }[] = [];

  // stripe_card: validated in the loop, CHARGED after sum validation (one per checkout, v1)
  let stripeCharge: {
    paymentMethodId: string;
    stripeCustomerId: string;
    amountCents: number;
    rowIndex: number;
  } | null = null;

  for (const payment of paymentsIn) {
    const amount = Math.floor(Number(payment.amountCents ?? 0));
    if (amount < 1) {
      throw createError({
        statusCode: 422,
        statusMessage: "Invalid payment amount",
      });
    }
    if (payment.method === "gift_card") {
      const code = String(payment.code ?? "")
        .trim()
        .toUpperCase();
      const { data: card } = await admin
        .from("gift_cards")
        .select("id, balance_cents, active, organization_id")
        .eq("code", code)
        .single();
      if (!card || card.organization_id !== orgId || !card.active) {
        throw createError({
          statusCode: 422,
          statusMessage: `Gift card ${code} not found`,
        });
      }
      if (card.balance_cents < amount) {
        throw createError({
          statusCode: 422,
          statusMessage: `Gift card balance is $${(card.balance_cents / 100).toFixed(2)}`,
        });
      }
      paymentRows.push({
        method: "gift_card",
        amount_cents: amount,
        gift_card_id: card.id,
        reference: code,
        stripe_payment_intent_id: null,
      });
    } else if (payment.method === "stripe_card") {
      if (stripeCharge) {
        throw createError({
          statusCode: 422,
          statusMessage: "Only one stripe card payment allowed per checkout",
        });
      }
      if (!body.clientId) {
        throw createError({
          statusCode: 422,
          statusMessage: "Card on file requires a client",
        });
      }
      const pmId = String(payment.paymentMethodId ?? "");
      const { data: savedCard } = await admin
        .from("client_payment_methods")
        .select(
          "stripe_payment_method_id, client_id, active, clients!inner(stripe_customer_id)",
        )
        .eq("stripe_payment_method_id", pmId)
        .eq("client_id", body.clientId)
        .eq("active", true)
        .maybeSingle();
      const stripeCustomerId = (
        savedCard?.clients as { stripe_customer_id: string | null } | null
      )?.stripe_customer_id;
      if (!savedCard || !stripeCustomerId) {
        throw createError({
          statusCode: 422,
          statusMessage: "Saved card not found for this client",
        });
      }
      stripeCharge = {
        paymentMethodId: pmId,
        stripeCustomerId,
        amountCents: amount,
        rowIndex: paymentRows.length,
      };

      paymentRows.push({
        method: "stripe_card",
        amount_cents: amount,
        gift_card_id: null,
        reference: null,
        stripe_payment_intent_id: null, // filled after the charge succeeds
      });
    } else if (
      payment.method === "card_external" ||
      payment.method === "cash"
    ) {
      paymentRows.push({
        method: payment.method,
        amount_cents: amount,
        gift_card_id: null,
        reference: payment.reference || null,
        stripe_payment_intent_id: null,
      });
    } else {
      throw createError({
        statusCode: 422,
        statusMessage: `Unknown payment method: ${payment.method}`,
      });
    }
    paymentsSum += amount;
  }

  if (total > 0 && paymentsSum !== total) {
    throw createError({
      statusCode: 422,
      statusMessage: `Payments ($${(paymentsSum / 100).toFixed(2)}) don't match total ($${(total / 100).toFixed(2)})`,
    });
  }

  // ---- Stripe charge (sync flow): money moves BEFORE any ledger write.
  // Success → we record it; failure → 402, nothing written. If a write fails
  // AFTER this succeeds, the webhook's orphan reconciliation flags it loudly.
  if (stripeCharge) {
    const stripe = useStripe();
    try {
      const intent = await stripe.paymentIntents.create({
        amount: stripeCharge.amountCents,
        currency: "usd",
        customer: stripeCharge.stripeCustomerId,
        payment_method: stripeCharge.paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          reserve_client_id: body.clientId,
          reserve_staff_id: staffId,
        },
      });
      if (intent.status !== "succeeded") {
        throw createError({
          statusCode: 402,
          statusMessage: `Card charge did not complete (${intent.status})`,
        });
      }
      paymentRows[stripeCharge.rowIndex]!.stripe_payment_intent_id = intent.id;
      paymentRows[stripeCharge.rowIndex]!.reference = intent.id;
    } catch (error: unknown) {
      const stripeError = error as { message?: string; statusCode?: number };
      if (stripeError.statusCode === 402) throw error; // our own throw above
      throw createError({
        statusCode: 402,
        statusMessage: stripeError.message ?? "Card was declined",
      });
    }
  }

  // ---- writes (service role; cleanup on failure) --------------------------------
  // 1. gift cards being SOLD
  for (const giftCard of giftCardsToCreate) {
    const { data: created, error } = await admin
      .from("gift_cards")
      .insert({
        organization_id: orgId,
        code: generateGiftCode(),
        initial_balance_cents: giftCard.amountCents,
        balance_cents: giftCard.amountCents,
        purchaser_client_id: body.clientId ?? null,
        recipient_name: giftCard.recipientName,
        recipient_email: giftCard.recipientEmail,
      })
      .select("id, code")
      .single();
    if (error || !created) {
      throw createError({
        statusCode: 500,
        statusMessage: "Could not create gift card",
      });
    }
    rows[giftCard.rowIndex]!.gift_card_id = created.id;
    rows[giftCard.rowIndex]!.name_snapshot += ` (${created.code})`;
  }

  // 2. the transaction
  const { data: txn, error: txnError } = await admin
    .from("transactions")
    .insert({
      organization_id: orgId,
      location_id: location.id,
      client_id: body.clientId ?? null,
      appointment_id: body.appointmentId ?? null,
      subtotal_cents: subtotal,
      discount_cents: discount,
      tax_cents: tax,
      tip_cents: tip,
      total_cents: total,
      checked_out_by: staffId,
      note: body.note || null,
    })
    .select("id")
    .single();
  if (txnError || !txn) {
    throw createError({
      statusCode: 500,
      statusMessage: txnError?.message ?? "Ledger write failed",
    });
  }

  // 3. items + payments (cleanup transaction on failure)
  const { error: itemsError } = await admin
    .from("transaction_items")
    .insert(rows.map((r) => ({ ...r, transaction_id: txn.id })));
  if (itemsError) {
    await admin.from("transaction_items").delete().eq("transaction_id", txn.id);
    await admin.from("transactions").delete().eq("id", txn.id);
    throw createError({ statusCode: 500, statusMessage: itemsError.message });
  }

  const { error: paymentsError } = await admin
    .from("payments")
    .insert(paymentRows.map((p) => ({ ...p, transaction_id: txn.id })));
  if (paymentsError) {
    await admin.from("payments").delete().eq("transaction_id", txn.id);
    await admin.from("transaction_items").delete().eq("transaction_id", txn.id);
    await admin.from("transactions").delete().eq("id", txn.id);
    throw createError({
      statusCode: 500,
      statusMessage: paymentsError.message,
    });
  }

  // 4. audit
  const { error: auditError } = await admin.from("audit_log").insert({
    actor_staff_id: staffId,
    actor_user_id: user.user.id,
    action: "pos.checkout",
    entity_type: "transaction",
    entity_id: txn.id,
    detail: {
      total_cents: total,
      items: rows.length,
      payments: paymentRows.length,
    },
  });
  if (auditError) {
    console.error("[checkout] audit failed:", auditError);
  }

  // 5. receipt (fire and forget)
  try {
    if (body.clientId) {
      const { data: client } = await admin
        .from("clients")
        .select("email, first_name")
        .eq("id", body.clientId)
        .single();
      if (client?.email) {
        sendMail({
          to: client.email,
          subject: "Your receipt from The Reserve",
          html: receiptEmail({
            firstName: client.first_name,
            items: rows.map((r) => ({
              name: r.name_snapshot,
              quantity: r.quantity,
              totalCents: r.total_cents + r.tax_cents,
            })),
            subtotalCents: subtotal,
            discountCents: discount,
            taxCents: tax,
            tipCents: tip,
            totalCents: total,
          }),
        }).catch((mailError) =>
          console.error("[checkout] receipt failed:", mailError),
        );
      }
    }
  } catch (receiptError) {
    console.error("[checkout] receipt failed:", receiptError);
  }

  return { id: txn.id, totalCents: total };
});
