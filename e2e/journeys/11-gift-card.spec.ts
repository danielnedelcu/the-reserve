import { signIn } from "../support/auth";
import { expect, test } from "../support/fixtures";
import { addProduct, completeButton, dollars, ledgerOf, pickClient } from "../support/money";

// Journey 11: a gift card is sold at checkout, its code read from the
// sale's detail on /transactions (the only place a front-desk person can
// read it after the sale), then spent on a second sale; the balance drops
// by exactly the amount. A third sale applies the remaining balance, and
// the balance moves under them before Charge — another sale spent it —
// so the route refuses the stale amount and nothing is written.

const CODE = /([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/;

test("a gift card sold at checkout pays for a later sale by exactly its amount, and a stale balance is refused with nothing written", async ({ page, context, org }) => {
  const desk = await org.staffMember("desk", "front_desk");
  const ada = await org.client("Ada");
  const oil = await org.product("Rose Oil", { price_cents: 3_000, taxable: false, stock_quantity: 10 });

  await signIn(context, desk.email, desk.password);

  // Sale 1: the card itself, $50 (gift cards are not taxed).
  await page.goto("/checkout");
  await pickClient(page, ada);
  const gift = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sell a gift card" }) });
  await gift.getByPlaceholder("Amount ($)").fill("50");
  await gift.getByPlaceholder("Recipient name (optional)").fill("Ada");
  await gift.getByRole("button", { name: "Add to sale" }).click();
  await expect(page.getByText("Gift card for Ada")).toBeVisible();
  await completeButton(page, 5_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  await expect(page).toHaveURL(/\/transactions$/);

  // The code, read from the sale's detail as the desk would.
  await page.getByRole("listitem").filter({ hasText: ada.firstName }).click(); // the sale row (the toast is a list item too)
  const dialog = page.getByRole("dialog");
  const line = dialog.getByText(/Gift card for Ada/);
  await expect(line).toBeVisible();
  const code = ((await line.textContent()) ?? "").match(CODE)?.[1];
  expect(code, "the sale's detail shows the card's code").toBeTruthy();
  await page.keyboard.press("Escape"); // the dialog has two Close controls (the X and the footer button)
  await expect(dialog).toBeHidden();

  // Sale 2: $30 of retail, paid with the card.
  await page.goto("/checkout");
  await pickClient(page, ada);
  await addProduct(page, oil);
  await page.getByLabel("Gift card code").fill(code!);
  await page.getByRole("button", { name: "Apply", exact: true }).click(); // not "Apply discount"
  await expect(page.getByText(`${code}: ${dollars(3_000)} applied`)).toBeVisible();
  await expect(page.getByText(`${dollars(3_000)} (balance ${dollars(5_000)})`)).toBeVisible(); // the toast reads the balance
  await completeButton(page, 3_000).click();
  await expect(page.getByText("Checkout complete")).toBeVisible();
  await expect(page).toHaveURL(/\/transactions$/);

  let ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(2);
  expect(ledger[1]!.payments.map((p) => [p.method, p.amount_cents, p.reference])).toEqual([["gift_card", 3_000, code]]);
  const { data: card } = await org.env.db.from("gift_cards").select("id, balance_cents, initial_balance_cents").eq("code", code!).single();
  expect(card?.initial_balance_cents).toBe(5_000);
  expect(card?.balance_cents).toBe(2_000);

  // Sale 3: the remaining $20 applied, the other $10 at the terminal —
  // then the balance moves under them before Charge.
  await page.goto("/checkout");
  await pickClient(page, ada);
  await addProduct(page, oil);
  await page.getByLabel("Gift card code").fill(code!);
  await page.getByRole("button", { name: "Apply", exact: true }).click(); // not "Apply discount"
  await expect(page.getByText(`${code}: ${dollars(2_000)} applied`)).toBeVisible();
  await expect(page.getByText(`Card (terminal): ${dollars(1_000)}`)).toBeVisible();
  const { error: moved } = await org.env.db.from("gift_cards").update({ balance_cents: 500 }).eq("id", card!.id); // spent elsewhere meanwhile
  expect(moved).toBeNull();
  await completeButton(page, 3_000).click();
  await expect(page.getByText("Checkout failed")).toBeVisible();
  await expect(page.getByText(`Gift card balance is ${dollars(500)}`)).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);

  ledger = await ledgerOf(org);
  expect(ledger).toHaveLength(2); // nothing written
  const { data: after } = await org.env.db.from("gift_cards").select("balance_cents").eq("id", card!.id).single();
  expect(after?.balance_cents).toBe(500);
});
