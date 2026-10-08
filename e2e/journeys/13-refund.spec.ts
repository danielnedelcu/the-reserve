import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, auditRows, completeButton, dollars, figureCard, ledgerOf, pickClient } from "../support/money";

// Journey 13: a refund from /transactions writes the mirror and restores
// the stock (apply_product_sale adds a negative line's quantity back);
// /financials nets to zero. Then the stale-page case: a second window
// still showing the Refund button refunds again — "Already refunded",
// whose "View refund" action opens the refund's own detail. That click
// had never been driven in a browser.

test("a refund writes the mirror, restores stock and nets /financials to zero; refunding again shows Already refunded, and View refund opens it", async ({ page, context, browser, org }) => {
  const desk = await org.staffMember("desk", "front_desk"); // pos.checkout; refunds need pos.refund
  const manager = await org.staffMember("manager", "admin"); // pos.refund, financials
  const noor = await org.client("Noor");
  const balm = await org.product("Lip Balm", { price_cents: 1_000, taxable: false, stock_quantity: 5 });

  await signIn(context, desk.email, desk.password);
  await page.goto("/checkout");
  await pickClient(page, noor);
  await addProduct(page, balm, 2);
  await completeButton(page, 2_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  const [sale] = await ledgerOf(org);
  expect((await org.env.db.from("products").select("stock_quantity").eq("id", balm.id).single()).data?.stock_quantity).toBe(3);

  // Window A: the manager opens the sale and sees Refund — and keeps it open.
  await context.clearCookies();
  await signIn(context, manager.email, manager.password);
  await page.goto("/transactions");
  await page.getByRole("listitem").filter({ hasText: noor.firstName }).click();
  const dialogA = page.getByRole("dialog");
  await expect(dialogA.getByRole("button", { name: "Refund" })).toBeVisible();

  // Window B: the same manager refunds it there.
  const contextB = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3300", timezoneId: "America/Los_Angeles" });
  try {
    await signIn(contextB, manager.email, manager.password);
    const pageB = await contextB.newPage();
    await pageB.goto("/transactions");
    await pageB.getByRole("listitem").filter({ hasText: noor.firstName }).click();
    pageB.once("dialog", (d) => d.accept()); // "Refund $20.00 to Noor…? This can't be undone."
    await pageB.getByRole("dialog").getByRole("button", { name: "Refund" }).click();
    await expect(pageB.getByText("Refunded", { exact: true })).toBeVisible();
    const rows = pageB.getByRole("listitem").filter({ hasText: noor.firstName }); // the two ledger rows, not the toast
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: /\brefund\b/ })).toContainText("20.00"); // the mirror, badged "refund"
    await expect(rows.filter({ hasText: /\brefunded\b/ })).toContainText(dollars(2_000)); // the original, badged "refunded"

    const ledger = await ledgerOf(org);
    expect(ledger).toHaveLength(2);
    const refund = ledger.find((t) => t.refunds_transaction_id === sale!.id)!;
    expect(refund.total_cents).toBe(-2_000);
    expect(refund.transaction_items.map((i) => [i.name_snapshot.startsWith("Refund — "), i.quantity, i.total_cents])).toEqual([[true, 2, -2_000]]);
    expect(refund.payments.map((p) => [p.method, p.amount_cents])).toEqual([["card_external", -2_000]]);
    expect((await org.env.db.from("products").select("stock_quantity").eq("id", balm.id).single()).data?.stock_quantity).toBe(5); // restored
    expect((await auditRows(org, "pos.refund")).map((a) => a.entity_id)).toEqual([sale!.id]);

    await pageB.goto("/financials");
    await expect(figureCard(pageB, "Revenue")).toContainText(dollars(0));
    await expect(figureCard(pageB, "Refunds")).toContainText(dollars(2_000));

    // Window A, stale: Refund again → Already refunded → View refund.
    page.once("dialog", (d) => d.accept());
    await dialogA.getByRole("button", { name: "Refund" }).click();
    await expect(page.getByText("Already refunded")).toBeVisible();
    await expect(page.getByText(`${dollars(2_000)} was refunded earlier.`)).toBeVisible();
    await page.getByRole("button", { name: "View refund" }).click();
    await expect(page).toHaveURL(new RegExp(`/transactions\\?open=${refund.id}`));
    const opened = page.getByRole("dialog");
    await expect(opened).toBeVisible();
    await expect(opened).toContainText("20.00");
    await expect(opened).toContainText("Refund — ");
    await expect(opened.getByRole("button", { name: "Refund" })).toHaveCount(0); // a refund cannot be refunded
    const ledgerAfter = await ledgerOf(org);
    expect(ledgerAfter).toHaveLength(2); // one refund per original
  } finally {
    await contextB.close();
  }
});
