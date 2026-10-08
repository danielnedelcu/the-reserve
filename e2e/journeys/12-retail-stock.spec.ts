import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, completeButton, dollars, ledgerOf, pickClient } from "../support/money";

// Journey 12: stock drops by the quantity sold — on /products as the desk
// sees it, and on the row. Adding the same product twice makes one line
// of quantity 2.

test("selling two of a product takes two from its stock on /products", async ({ page, context, org }) => {
  const desk = await org.staffMember("desk", "front_desk");
  const noor = await org.client("Noor");
  const balm = await org.product("Lip Balm", { price_cents: 1_000, taxable: false, stock_quantity: 5 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, noor);
  await addProduct(page, balm, 2);
  await expect(page.getByText("× 2")).toBeVisible();
  await completeButton(page, 2_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();

  const ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.transaction_items.map((i) => [i.quantity, i.total_cents])).toEqual([[2, 2_000]]);

  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search name, SKU…" }).fill(balm.name);
  const row = page.getByRole("row", { name: new RegExp(balm.name) });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(2)).toContainText("3"); // Product · Price · Stock (no margin column for the desk)
  await expect(row).toContainText(dollars(1_000));
  const { data: product } = await org.env.db.from("products").select("stock_quantity").eq("id", balm.id).single();
  expect(product?.stock_quantity).toBe(3);
});
