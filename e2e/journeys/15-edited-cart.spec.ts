import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, completeButton, ledgerOf, pickClient } from "../support/money";

// Journey 15: the response is lost, then the cart is changed before
// Charge is pressed again. The same key with a different cart is a 409:
// the page says the first sale went through and the cart has changed,
// nothing is overwritten, and because the page minted a new key, the
// next Charge is a NEW sale with the edited cart.

test("an edited cart after a lost response is refused as already recorded, overwrites nothing, and the next Charge is a new sale", async ({ page, context, org }) => {
  const desk = await org.staffMember("desk", "front_desk");
  const noor = await org.client("Noor");
  const balm = await org.product("Lip Balm", { price_cents: 1_000, taxable: false, stock_quantity: 10 });
  const oil = await org.product("Rose Oil", { price_cents: 3_000, taxable: false, stock_quantity: 10 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, noor);
  await addProduct(page, balm);
  await page.route("**/api/checkout", async (route) => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await completeButton(page, 1_000).click();
  await expect(page.getByText("Checkout failed")).toBeVisible();
  const [first] = await ledgerOf(org);
  expect(first?.total_cents).toBe(1_000);

  // The cart changes, then Charge again with the key the page still holds.
  await addProduct(page, oil);
  await completeButton(page, 4_000).click();
  await expect(page.getByText("This sale was already recorded")).toBeVisible();
  await expect(page.getByText(new RegExp(`The first charge went through \\(transaction ${first!.id.slice(0, 8)}\\) and the cart has changed since`))).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
  let ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.total_cents).toBe(1_000); // untouched
  expect(ledger[0]!.transaction_items).toHaveLength(1);

  // The page minted a new key on the 409: this Charge is a new sale.
  await completeButton(page, 4_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  ledger = await ledgerOf(org);
  expect(ledger.map((t) => t.total_cents)).toEqual([1_000, 4_000]);
  expect(ledger[0]!.transaction_items).toHaveLength(1);
  expect(ledger[1]!.transaction_items).toHaveLength(2);
  expect(ledger[0]!.idempotency_key).not.toBe(ledger[1]!.idempotency_key);
});
