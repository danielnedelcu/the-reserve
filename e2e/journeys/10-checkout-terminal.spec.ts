import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, auditRows, completeButton, dollars, figureCard, ledgerOf, pickClient } from "../support/money";

// Journey 10: a retail sale at the card terminal, in the run's own
// organisation, then the same sale's figures on /financials. The
// organisation holds nothing else, so every figure is exact, not
// "increased by". The tender is the one the page offers for a card
// taken at the counter ("Card terminal (external)"); the page has no
// cash tender today.

test("a retail sale rung up at the terminal lands on the ledger and shows on /financials with the figures charged", async ({ page, context, org }) => {
  const desk = await org.staffMember("desk", "front_desk");
  const owner = await org.staffMember("owner", "admin");
  const noor = await org.client("Noor");
  const lotion = await org.product("Lavender Lotion", { price_cents: 2_400, taxable: true, stock_quantity: 10 });
  // 8% tax on $24.00 = $1.92; total $25.92.
  const subtotal = 2_400, tax = 192, total = 2_592;

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, noor);
  await addProduct(page, lotion);
  await expect(page.getByText(`Card (terminal): ${dollars(total)}`)).toBeVisible();
  await page.getByPlaceholder("Terminal receipt # (optional)").fill(`TERM-${org.run}`);
  await completeButton(page, total).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  await expect(page).toHaveURL(/\/transactions$/);
  const row = page.getByRole("listitem").filter({ hasText: noor.firstName });
  await expect(row).toContainText(dollars(total));
  await expect(row).toContainText("Card");

  // The ledger: one transaction, balanced, every row carrying the organisation.
  const ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(1);
  const sale = ledger[0]!;
  expect(sale.subtotal_cents).toBe(subtotal);
  expect(sale.tax_cents).toBe(tax);
  expect(sale.total_cents).toBe(total);
  expect(sale.transaction_items.map((i) => [i.kind, i.quantity, i.total_cents, i.organization_id])).toEqual([["product", 1, subtotal, org.orgId]]);
  expect(sale.payments.map((p) => [p.method, p.amount_cents, p.reference, p.organization_id])).toEqual([["card_external", total, `TERM-${org.run}`, org.orgId]]);
  const audit = await auditRows(org, "pos.checkout");
  expect(audit.map((a) => [a.actor_staff_id, a.entity_id])).toEqual([[desk.id, sale.id]]);

  // /financials as the owner: the month's figures are this sale's.
  await context.clearCookies();
  await signIn(context, owner.email, owner.password);
  await page.goto("/financials");
  await expect(page.getByRole("heading", { name: "Financials" })).toBeVisible();
  await expect(figureCard(page, "Revenue")).toContainText(dollars(subtotal));
  await expect(figureCard(page, "Revenue")).toContainText(`${dollars(subtotal)} retail`);
  await expect(figureCard(page, "Transactions").locator("p.text-2xl")).toHaveText(/^1\b/);
  await expect(figureCard(page, "Tax collected")).toContainText(dollars(tax));
  await expect(figureCard(page, "Refunds")).toContainText(dollars(0));
});
