import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 7: the checkout's two pickers search the server. The client
// sorts past the first thousand (the case the old loaded-everything
// select could not reach) and is found by typing; a product is found by
// typing and lands in the cart with its price. No sale is completed —
// the ledger is append-only and no journey writes to it in this PR.

test("checkout finds a late-alphabet client and a product by search, without completing a sale", async ({ page, context, data }) => {
  const desk = await data.staffMember("desk", "front_desk"); // pos.checkout, clients.view, products.view
  await data.clientsBulk(1_100);
  const client = await data.client("Zara", `Zz-${data.tag}`, { email: `zara-${data.run}@reserve.test` });
  const product = await data.product("Lavender Lotion", { sku: `LAV-${data.run}`, price_cents: 2_400, stock_quantity: 12 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await expect(page.getByRole("heading", { name: /checkout|new sale/i })).toBeVisible();

  // The client: typed, found with their email beneath, chosen, shown.
  const clientBox = page.getByRole("combobox", { name: "Client (optional)" });
  await clientBox.fill(client.lastName);
  const option = page.getByRole("option", { name: new RegExp(`^${client.lastName}, ${client.firstName}`) });
  await expect(option).toContainText(`zara-${data.run}@reserve.test`);
  await option.click();
  await expect(clientBox).toHaveValue(`${client.lastName}, ${client.firstName}`);

  // The product: typed, found with its price, added to the cart.
  const productBox = page.getByRole("combobox", { name: "Add retail product" });
  await productBox.fill(data.tag);
  const productOption = page.getByRole("option", { name: new RegExp(`^${product.name}`) });
  await expect(productOption).toContainText("$24.00");
  await productOption.click();
  await expect(page.getByText(product.name).first()).toBeVisible();
  await expect(productBox).toHaveValue(""); // an action, not a choice: the box clears

  // Nothing was charged: the page is still the cart, not a receipt.
  await expect(page.getByRole("button", { name: /charge|take payment|complete/i }).first()).toBeVisible();
});
