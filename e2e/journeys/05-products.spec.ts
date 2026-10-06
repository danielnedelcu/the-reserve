import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Journey 5: /products on the same pattern as /clients, with one
// difference the design chose (decision 5): product names are not
// sensitive, so the SEARCH is in the URL too — shareable, and it survives
// a reload through the address rather than this tab's storage. The stock
// filter is in the URL like any other filter.

test("a product search lives in the URL and survives a reload, with the stock filter beside it", async ({ page, context, data }) => {
  const desk = await data.staffMember("desk", "front_desk");
  await data.product("Lavender Lotion", { sku: `LAV-${data.run}`, stock_quantity: 12 });
  await data.product("Rose Oil", { sku: `ROSE-${data.run}`, stock_quantity: 0 });
  await data.product("Sea Salt Scrub", { sku: `SALT-${data.run}`, stock_quantity: 3 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();

  // Search by the run's tag: the URL carries it.
  await page.getByRole("searchbox", { name: "Search name, SKU…" }).fill(data.tag);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${data.tag}`));
  await expect(page.getByText(`${data.tag} Lavender Lotion`)).toBeVisible();
  await expect(page.getByText(`${data.tag} Rose Oil`)).toBeVisible();
  await expect(page.getByText("3 products")).toBeVisible();

  // A search by SKU finds the one product.
  await page.getByRole("searchbox", { name: "Search name, SKU…" }).fill(`ROSE-${data.run}`);
  await expect(page.getByText("1 product", { exact: true })).toBeVisible();
  await expect(page.getByText(`${data.tag} Rose Oil`)).toBeVisible();

  // Reload: the search comes back from the address, not from this tab.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`[?&]q=ROSE-${data.run}`));
  await expect(page.getByRole("searchbox", { name: "Search name, SKU…" })).toHaveValue(`ROSE-${data.run}`);
  await expect(page.getByText(`${data.tag} Rose Oil`)).toBeVisible();
  await expect(page.getByText(`${data.tag} Lavender Lotion`)).toHaveCount(0);

  // The stock filter: out of stock, in the URL, applied with the search.
  await page.getByRole("searchbox", { name: "Search name, SKU…" }).fill(data.tag);
  await page.getByRole("combobox", { name: "Stock" }).click();
  await page.getByRole("option", { name: "Out of stock" }).click();
  await expect(page).toHaveURL(/[?&]stock=out/);
  await expect(page.getByText("1 product", { exact: true })).toBeVisible();
  await expect(page.getByText(`${data.tag} Rose Oil`)).toBeVisible();
  await expect(page.getByText(`${data.tag} Sea Salt Scrub`)).toHaveCount(0);
});
