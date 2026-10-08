import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "~~/shared/types/database";

/**
 * The one call that writes ledger rows: write_ledger_transaction
 * (docs/design/ledger-integrity-design.md, PR 1). Header, lines and
 * payments land in ONE database transaction, keyed so a retry after a
 * lost response returns the existing transaction and writes nothing.
 * Every route that used to insert the three tables in sequence with
 * compensating deletes calls this instead; the pricing and the Stripe
 * calls stay in the route, which calls this once after the money moved.
 *
 * The function's errors, mapped for the route:
 *   LD001  the key was already used for a DIFFERENT request → 409, with
 *          the first transaction's id in `data.transactionId`, so the page
 *          can show staff that the first sale went through
 *   LD002  a referenced row belongs to another organisation → 404
 *   22023  a malformed request (unknown key, no lines) → 500: a bug here
 */
export interface LedgerHeader {
  location_id: string;
  client_id: string | null;
  appointment_id: string | null;
  refunds_transaction_id?: string | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  checked_out_by: string;
  note: string | null;
}
export interface LedgerItem {
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
export interface LedgerPayment {
  method: string;
  amount_cents: number;
  gift_card_id: string | null;
  reference: string | null;
  stripe_payment_intent_id: string | null;
}

export async function writeLedgerTransaction(
  admin: SupabaseClient<Database>,
  input: {
    organizationId: string;
    idempotencyKey: string;
    header: LedgerHeader;
    items: LedgerItem[];
    payments: LedgerPayment[];
  },
): Promise<string> {
  const { data, error } = await admin.rpc("write_ledger_transaction", {
    p_organization_id: input.organizationId,
    p_idempotency_key: input.idempotencyKey,
    p_header: input.header as unknown as Json,
    p_items: input.items as unknown as Json,
    p_payments: input.payments as unknown as Json,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    const details = (error as { details?: string }).details;
    if (code === "LD001") {
      throw createError({
        statusCode: 409,
        statusMessage: "This sale was already recorded with different lines or payments",
        data: { transactionId: details ?? null },
      });
    }
    if (code === "LD002") {
      throw createError({ statusCode: 404, statusMessage: "A referenced record was not found in this organisation" });
    }
    throw createError({ statusCode: 500, statusMessage: `Ledger write failed: ${error.message}` });
  }
  if (!data) throw createError({ statusCode: 500, statusMessage: "Ledger write returned no id" });
  return data as string;
}

/** The idempotency key for a checkout: the Stripe charge when there is one, else the page's per-cart key. */
export function checkoutIdempotencyKey(paymentIntentId: string | null, cartKey: string): string {
  return paymentIntentId ? `pi:${paymentIntentId}` : `checkout:${cartKey}`;
}
