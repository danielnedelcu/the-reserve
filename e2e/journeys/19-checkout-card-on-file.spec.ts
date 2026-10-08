import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, completeButton, dollars, ledgerOf, pickClient } from "../support/money";
import { sandbox } from "../support/stripe";

// Journey 19 (@stripe): a sale paid with the client's card on file —
// the checkout page offers the saved card once the client is picked,
// the route charges it through Stripe and writes the ledger only after
// the charge succeeded — then a refund from /transactions pushes the
// Stripe refund BEFORE the mirror is written.

test("a sale on the card on file is charged through Stripe and refunded through Stripe, the ledger following the money both ways @stripe", { tag: "@stripe" }, async ({ page, context, org }) => {
  const stripe = await sandbox();
  const desk = await org.staffMember("desk", "front_desk");
  const manager = await org.staffMember("manager", "admin"); // pos.refund
  const ada = await org.client("Ada");
  const card = await org.savedCard(stripe, ada.id, desk.id, "pm_card_visa");
  const oil = await org.product("Rose Oil", { price_cents: 3_000, taxable: false, stock_quantity: 10 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, ada);
  await addProduct(page, oil);
  const onFile = page.getByRole("radio", { name: new RegExp(`Card on file — ${card.brand} •••• ${card.last4}`) });
  await expect(onFile).toBeVisible();
  await onFile.check();
  await expect(page.getByText(`Charge on file: ${dollars(3_000)}`)).toBeVisible();
  await completeButton(page, 3_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  await expect(page).toHaveURL(/\/transactions$/);

  const [sale] = await ledgerOf(org);
  expect(sale?.total_cents).toBe(3_000);
  const { data: payment } = await org.env.db.from("payments").select("method, amount_cents, stripe_payment_intent_id").eq("transaction_id", sale!.id).single();
  expect(payment?.method).toBe("stripe_card");
  expect(payment?.stripe_payment_intent_id).toMatch(/^pi_/);
  const intent = await stripe.paymentIntents.retrieve(payment!.stripe_payment_intent_id!);
  expect(intent.status).toBe("succeeded");
  expect(intent.amount).toBe(3_000);
  expect(intent.customer).toBe(card.customerId);

  // The refund, as the manager: Stripe first, then the mirror.
  await context.clearCookies();
  await signIn(context, manager.email, manager.password);
  await page.goto("/transactions");
  await page.getByRole("listitem").filter({ hasText: ada.firstName }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("dialog").getByRole("button", { name: "Refund" }).click();
  await expect(page.getByText("Refunded", { exact: true })).toBeVisible();

  const ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(2);
  const mirror = ledger.find((t) => t.refunds_transaction_id === sale!.id)!;
  expect(mirror.total_cents).toBe(-3_000);
  const { data: mirrorPayment } = await org.env.db.from("payments").select("method, amount_cents, stripe_payment_intent_id").eq("transaction_id", mirror.id).single();
  expect(mirrorPayment?.method).toBe("stripe_card");
  expect(mirrorPayment?.amount_cents).toBe(-3_000);
  expect(mirrorPayment?.stripe_payment_intent_id).toBe(payment!.stripe_payment_intent_id);
  const refunds = (await stripe.refunds.list({ payment_intent: payment!.stripe_payment_intent_id! })).data;
  expect(refunds.map((r) => [r.amount, r.status])).toEqual([[3_000, "succeeded"]]);
});
