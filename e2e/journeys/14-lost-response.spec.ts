import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, auditRows, completeButton, ledgerOf, pickClient } from "../support/money";

// Journey 14: the response is lost. Charge is pressed, the request
// reaches the server and the sale commits, but the reply never arrives
// in the browser. The page keeps its idempotency key; Charge again records
// nothing new — exactly one transaction, one stock movement, one audit row.

test("a lost response then Charge again records the sale exactly once", async ({ page, context, org }) => {
  const desk = await org.staffMember("desk", "front_desk");
  const noor = await org.client("Noor");
  const balm = await org.product("Lip Balm", { price_cents: 1_000, taxable: false, stock_quantity: 10 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, noor);
  await addProduct(page, balm);

  // Let the request through, lose the reply — once.
  await page.route("**/api/checkout", async (route) => {
    await route.fetch(); // the server commits
    await route.abort("failed"); // the browser never hears
  }, { times: 1 });
  await completeButton(page, 1_000).click();
  await expect(page.getByText("Checkout failed")).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
  expect(await ledgerOf(org)).toHaveLength(1); // it did go through

  // Charge again: the same key, the same sale.
  await completeButton(page, 1_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  await expect(page).toHaveURL(/\/transactions$/);

  const ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.transaction_items).toHaveLength(1);
  expect(ledger[0]!.payments).toHaveLength(1);
  expect((await org.env.db.from("products").select("stock_quantity").eq("id", balm.id).single()).data?.stock_quantity).toBe(9);
  expect(await auditRows(org, "pos.checkout")).toHaveLength(1);
});
